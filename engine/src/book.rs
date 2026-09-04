use std::collections::{BTreeMap, HashMap, VecDeque};

use crate::{Event, Fill, OrderId, Owner, Price, Qty, Side};

#[derive(Clone, Copy, Debug)]
struct Resting {
    id: OrderId,
    qty: Qty,
    owner: Owner,
}

/// The order book. Two sides, each a map from price to a FIFO queue of
/// resting orders. BTreeMap gives us the best price in O(log n) and keeps
/// the code honest and readable; a production engine would use a flat array
/// of price levels, but the sim never has enough levels for that to matter
/// (see the benchmarks in the README for what "not mattering" costs).
pub struct Book {
    bids: BTreeMap<Price, VecDeque<Resting>>,
    asks: BTreeMap<Price, VecDeque<Resting>>,
    /// Where each live resting order sits, so cancels don't have to search
    /// the whole book. The queue itself is scanned linearly on cancel, which
    /// is fine because individual levels stay short.
    index: HashMap<OrderId, (Side, Price)>,
    next_id: OrderId,
    /// Matching appends here; the caller drains it. Kept as a field so the
    /// allocation is reused across calls.
    pub events: Vec<Event>,
}

impl Book {
    pub fn new() -> Book {
        Book {
            bids: BTreeMap::new(),
            asks: BTreeMap::new(),
            index: HashMap::new(),
            next_id: 1,
            events: Vec::new(),
        }
    }

    pub fn best_bid(&self) -> Option<Price> {
        self.bids.last_key_value().map(|(p, _)| *p)
    }

    pub fn best_ask(&self) -> Option<Price> {
        self.asks.first_key_value().map(|(p, _)| *p)
    }

    /// Total resting quantity at the top `n` levels of one side, best first.
    pub fn depth(&self, side: Side, n: usize) -> Vec<(Price, Qty)> {
        let levels: Box<dyn Iterator<Item = (&Price, &VecDeque<Resting>)>> = match side {
            Side::Buy => Box::new(self.bids.iter().rev()),
            Side::Sell => Box::new(self.asks.iter()),
        };
        levels
            .take(n)
            .map(|(p, q)| (*p, q.iter().map(|o| o.qty).sum()))
            .collect()
    }

    pub fn is_live(&self, id: OrderId) -> bool {
        self.index.contains_key(&id)
    }

    /// Side, price, and remaining quantity of a live resting order.
    pub fn resting(&self, id: OrderId) -> Option<(Side, Price, Qty)> {
        let (side, price) = *self.index.get(&id)?;
        let map = match side {
            Side::Buy => &self.bids,
            Side::Sell => &self.asks,
        };
        let order = map.get(&price)?.iter().find(|o| o.id == id)?;
        Some((side, price, order.qty))
    }

    /// Submit a limit order. It matches as far as it can, and whatever is
    /// left rests on the book. Returns the order id; fills and self-match
    /// cancels land in `self.events`.
    pub fn limit(&mut self, side: Side, price: Price, qty: Qty, owner: Owner) -> OrderId {
        let id = self.next_id;
        self.next_id += 1;
        let remaining = self.take(side, price, qty, id, owner);
        if remaining > 0 {
            let level = match side {
                Side::Buy => self.bids.entry(price).or_default(),
                Side::Sell => self.asks.entry(price).or_default(),
            };
            level.push_back(Resting {
                id,
                qty: remaining,
                owner,
            });
            self.index.insert(id, (side, price));
        }
        id
    }

    /// Immediate-or-cancel: match what crosses, drop the rest. Returns the
    /// quantity actually filled.
    pub fn ioc(&mut self, side: Side, price: Price, qty: Qty, owner: Owner) -> Qty {
        let id = self.next_id;
        self.next_id += 1;
        qty - self.take(side, price, qty, id, owner)
    }

    /// A market order is just an IOC with the worst acceptable price.
    pub fn market(&mut self, side: Side, qty: Qty, owner: Owner) -> Qty {
        let limit = match side {
            Side::Buy => Price::MAX,
            Side::Sell => 0,
        };
        self.ioc(side, limit, qty, owner)
    }

    /// Remove every resting order without emitting events. This is what a
    /// trading halt with a quote purge looks like from the book's side.
    pub fn purge_all(&mut self) {
        self.bids.clear();
        self.asks.clear();
        self.index.clear();
    }

    pub fn cancel(&mut self, id: OrderId) -> bool {
        let Some((side, price)) = self.index.remove(&id) else {
            return false;
        };
        let map = match side {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        };
        let level = map.get_mut(&price).expect("index points at a live level");
        let pos = level
            .iter()
            .position(|o| o.id == id)
            .expect("index points at a live order");
        level.remove(pos);
        if level.is_empty() {
            map.remove(&price);
        }
        true
    }

    /// The matching loop. Walks the opposite side from the best price while
    /// the incoming order still crosses, respecting FIFO within each level.
    /// Returns the unfilled remainder.
    fn take(
        &mut self,
        side: Side,
        limit: Price,
        mut qty: Qty,
        taker: OrderId,
        owner: Owner,
    ) -> Qty {
        let (opposite, index, events) = match side {
            Side::Buy => (&mut self.asks, &mut self.index, &mut self.events),
            Side::Sell => (&mut self.bids, &mut self.index, &mut self.events),
        };
        while qty > 0 {
            let best = match side {
                Side::Buy => opposite.first_key_value().map(|(p, _)| *p),
                Side::Sell => opposite.last_key_value().map(|(p, _)| *p),
            };
            let Some(price) = best else { break };
            let crosses = match side {
                Side::Buy => price <= limit,
                Side::Sell => price >= limit,
            };
            if !crosses {
                break;
            }
            let level = opposite.get_mut(&price).expect("best price exists");
            while qty > 0 {
                let Some(head) = level.front_mut() else { break };
                if head.owner == owner {
                    // Self-match prevention: drop the resting order rather
                    // than trade with ourselves, then keep going.
                    events.push(Event::SelfMatch {
                        canceled: head.id,
                        owner,
                        lost_qty: head.qty,
                    });
                    index.remove(&head.id);
                    level.pop_front();
                    continue;
                }
                let traded = qty.min(head.qty);
                events.push(Event::Fill(Fill {
                    price,
                    qty: traded,
                    maker: head.id,
                    maker_owner: head.owner,
                    taker,
                    taker_owner: owner,
                    taker_side: side,
                }));
                head.qty -= traded;
                qty -= traded;
                if head.qty == 0 {
                    index.remove(&head.id);
                    level.pop_front();
                }
            }
            if level.is_empty() {
                opposite.remove(&price);
            }
        }
        qty
    }
}

impl Default for Book {
    fn default() -> Self {
        Book::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fills(book: &mut Book) -> Vec<Fill> {
        book.events
            .drain(..)
            .filter_map(|e| match e {
                Event::Fill(f) => Some(f),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn resting_order_sits_on_the_book() {
        let mut b = Book::new();
        b.limit(Side::Buy, 100, 10, 1);
        assert_eq!(b.best_bid(), Some(100));
        assert_eq!(b.best_ask(), None);
        assert!(fills(&mut b).is_empty());
    }

    #[test]
    fn crossing_limit_trades_at_the_resting_price() {
        let mut b = Book::new();
        let maker = b.limit(Side::Sell, 101, 10, 1);
        b.limit(Side::Buy, 105, 4, 2);
        let f = fills(&mut b);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].price, 101); // maker's price, not the taker's limit
        assert_eq!(f[0].qty, 4);
        assert_eq!(f[0].maker, maker);
        assert_eq!(b.depth(Side::Sell, 1), vec![(101, 6)]);
    }

    #[test]
    fn fifo_within_a_level() {
        let mut b = Book::new();
        let first = b.limit(Side::Sell, 101, 5, 1);
        let second = b.limit(Side::Sell, 101, 5, 2);
        b.market(Side::Buy, 7, 3);
        let f = fills(&mut b);
        assert_eq!(f.len(), 2);
        assert_eq!((f[0].maker, f[0].qty), (first, 5));
        assert_eq!((f[1].maker, f[1].qty), (second, 2));
    }

    #[test]
    fn better_price_matches_first() {
        let mut b = Book::new();
        b.limit(Side::Sell, 102, 5, 1);
        let cheap = b.limit(Side::Sell, 101, 5, 2);
        b.market(Side::Buy, 3, 3);
        let f = fills(&mut b);
        assert_eq!(f[0].maker, cheap);
        assert_eq!(f[0].price, 101);
    }

    #[test]
    fn partial_fill_rests_the_remainder() {
        let mut b = Book::new();
        b.limit(Side::Sell, 101, 3, 1);
        b.limit(Side::Buy, 101, 10, 2);
        assert_eq!(fills(&mut b)[0].qty, 3);
        assert_eq!(b.depth(Side::Buy, 1), vec![(101, 7)]);
        assert_eq!(b.best_ask(), None);
    }

    #[test]
    fn ioc_never_rests() {
        let mut b = Book::new();
        b.limit(Side::Sell, 101, 3, 1);
        let filled = b.ioc(Side::Buy, 101, 10, 2);
        assert_eq!(filled, 3);
        assert_eq!(b.best_bid(), None);
    }

    #[test]
    fn cancel_removes_the_order() {
        let mut b = Book::new();
        let id = b.limit(Side::Buy, 100, 10, 1);
        assert!(b.cancel(id));
        assert!(!b.cancel(id));
        assert_eq!(b.best_bid(), None);
    }

    #[test]
    fn self_match_cancels_the_resting_order() {
        let mut b = Book::new();
        let mine = b.limit(Side::Sell, 101, 5, 1);
        let other = b.limit(Side::Sell, 101, 5, 2);
        b.limit(Side::Buy, 101, 8, 1);
        let evs = std::mem::take(&mut b.events);
        // Our own resting order is dropped, then we trade with the other one.
        assert_eq!(
            evs[0],
            Event::SelfMatch {
                canceled: mine,
                owner: 1,
                lost_qty: 5
            }
        );
        match evs[1] {
            Event::Fill(f) => {
                assert_eq!(f.maker, other);
                assert_eq!(f.qty, 5);
            }
            _ => panic!("expected a fill after the self-match cancel"),
        }
        // 8 wanted, 5 traded, 3 rest on the bid.
        assert_eq!(b.depth(Side::Buy, 1), vec![(101, 3)]);
    }

    #[test]
    fn book_never_stays_crossed() {
        let mut b = Book::new();
        b.limit(Side::Buy, 100, 10, 1);
        b.limit(Side::Sell, 99, 25, 2);
        let f = fills(&mut b);
        assert_eq!(f[0].price, 100);
        assert_eq!(f[0].qty, 10);
        if let (Some(bb), Some(ba)) = (b.best_bid(), b.best_ask()) {
            assert!(bb < ba);
        }
    }
}
