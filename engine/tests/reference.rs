//! Differential test: run random order streams through the real engine and
//! through a deliberately naive reference book, and check they emit exactly
//! the same events. The reference does everything by brute-force scanning,
//! which makes it slow and hard to get wrong. If the two ever disagree, the
//! failing seed prints so the case can be replayed.

use pit_engine::{Book, Event, Owner, Price, Qty, Side};

struct RefOrder {
    id: u64,
    side: Side,
    price: Price,
    qty: Qty,
    owner: Owner,
    seq: u64, // arrival order, for time priority
}

struct RefBook {
    resting: Vec<RefOrder>,
    next_id: u64,
    next_seq: u64,
    events: Vec<Event>,
}

impl RefBook {
    fn new() -> RefBook {
        RefBook {
            resting: Vec::new(),
            next_id: 1,
            next_seq: 0,
            events: Vec::new(),
        }
    }

    /// Index of the best order on the opposite side that an incoming order
    /// would trade against: best price first, oldest at that price first.
    fn best_opposite(&self, side: Side, limit: Price) -> Option<usize> {
        let mut best: Option<usize> = None;
        for (i, o) in self.resting.iter().enumerate() {
            if o.side == side {
                continue;
            }
            let crosses = match side {
                Side::Buy => o.price <= limit,
                Side::Sell => o.price >= limit,
            };
            if !crosses {
                continue;
            }
            best = match best {
                None => Some(i),
                Some(j) => {
                    let b = &self.resting[j];
                    let better_price = match side {
                        Side::Buy => o.price < b.price,
                        Side::Sell => o.price > b.price,
                    };
                    if better_price || (o.price == b.price && o.seq < b.seq) {
                        Some(i)
                    } else {
                        Some(j)
                    }
                }
            };
        }
        best
    }

    fn take(&mut self, side: Side, limit: Price, mut qty: Qty, taker: u64, owner: Owner) -> Qty {
        while qty > 0 {
            let Some(i) = self.best_opposite(side, limit) else {
                break;
            };
            if self.resting[i].owner == owner {
                let o = self.resting.remove(i);
                self.events.push(Event::SelfMatch {
                    canceled: o.id,
                    owner,
                    lost_qty: o.qty,
                });
                continue;
            }
            let traded = qty.min(self.resting[i].qty);
            let o = &mut self.resting[i];
            self.events.push(Event::Fill(pit_engine::Fill {
                price: o.price,
                qty: traded,
                maker: o.id,
                maker_owner: o.owner,
                taker,
                taker_owner: owner,
                taker_side: side,
            }));
            o.qty -= traded;
            qty -= traded;
            if self.resting[i].qty == 0 {
                self.resting.remove(i);
            }
        }
        qty
    }

    fn limit(&mut self, side: Side, price: Price, qty: Qty, owner: Owner) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let left = self.take(side, price, qty, id, owner);
        if left > 0 {
            self.resting.push(RefOrder {
                id,
                side,
                price,
                qty: left,
                owner,
                seq: self.next_seq,
            });
            self.next_seq += 1;
        }
        id
    }

    fn market(&mut self, side: Side, qty: Qty, owner: Owner) {
        let id = self.next_id;
        self.next_id += 1;
        let limit = match side {
            Side::Buy => Price::MAX,
            Side::Sell => 0,
        };
        self.take(side, limit, qty, id, owner);
    }

    fn cancel(&mut self, id: u64) -> bool {
        match self.resting.iter().position(|o| o.id == id) {
            Some(i) => {
                self.resting.remove(i);
                true
            }
            None => false,
        }
    }
}

// Small xorshift so the test needs no dependencies. Quality doesn't matter
// here, coverage of weird interleavings does.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[test]
fn engine_matches_the_reference_on_random_streams() {
    for seed in 1..=50u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9e3779b97f4a7c15));
        let mut real = Book::new();
        let mut naive = RefBook::new();
        let mut ids: Vec<u64> = Vec::new();

        for step in 0..4000 {
            let side = if rng.below(2) == 0 {
                Side::Buy
            } else {
                Side::Sell
            };
            // Prices cluster around 1000 so the sides actually interact.
            let price = (990 + rng.below(21)) as Price;
            let qty = (1 + rng.below(50)) as Qty;
            let owner = (1 + rng.below(6)) as Owner;

            match rng.below(10) {
                0..=5 => {
                    let a = real.limit(side, price, qty, owner);
                    let b = naive.limit(side, price, qty, owner);
                    assert_eq!(a, b, "id drift, seed {seed} step {step}");
                    ids.push(a);
                }
                6..=7 => {
                    real.market(side, qty, owner);
                    naive.market(side, qty, owner);
                }
                _ => {
                    if !ids.is_empty() {
                        let id = ids[rng.below(ids.len() as u64) as usize];
                        assert_eq!(
                            real.cancel(id),
                            naive.cancel(id),
                            "cancel disagreement, seed {seed} step {step}"
                        );
                    }
                }
            }

            assert_eq!(
                real.events, naive.events,
                "event streams diverged, seed {seed} step {step}"
            );
            real.events.clear();
            naive.events.clear();

            if let (Some(bb), Some(ba)) = (real.best_bid(), real.best_ask()) {
                assert!(bb < ba, "book crossed, seed {seed} step {step}");
            }
        }
    }
}
