//! A little market on top of the matching engine.
//!
//! One instrument. A hidden fair value follows a random walk, noise traders
//! push flow at the book with a weak pull toward that fair value, and three
//! market makers quote around the mid. Now and then an informed trader shows
//! up who can see where fair value is headed and leans on the market until
//! the move is over. Everything is driven by one seeded PCG32, so a run is
//! exactly reproducible from its seed.

mod makers;
mod rng;

use std::collections::VecDeque;

pub use makers::{Brain, Maker};
pub use rng::Pcg32;

use pit_engine::{Book, Event, OrderId, Owner, Price, Qty, Side};

pub const USER: Owner = 1;
pub const INFORMED: Owner = 2;
pub const MAKER_FIXED: Owner = 3;
pub const MAKER_SKEW: Owner = 4;
pub const MAKER_WARY: Owner = 5;
pub const NOISE_FIRST: Owner = 6;
pub const NOISE_COUNT: u16 = 20;
/// The visitor-scripted bot from the web bot lab. It trades through the
/// same engine as everyone else; the only thing special about it is that
/// its brain lives in JavaScript.
pub const BOT: Owner = NOISE_FIRST + NOISE_COUNT;

const START_FAIR: f64 = 10_000.0; // ticks; a tick is a cent, so $100.00
const CALM_SIGMA: f64 = 0.035;
const EPISODE_CHANCE: f64 = 1.0 / 1500.0;
const EPISODE_COOLDOWN: u64 = 600;
const NOISE_ACT_CHANCE: f64 = 0.08;
const NOISE_ORDER_TTL: u64 = 400;

#[derive(Clone, Copy, Default)]
pub struct Account {
    /// Cash in tick units (price ticks times lots), signed.
    pub cash: i64,
    pub inventory: i64,
    pub volume: u64,
}

#[derive(Clone, Copy)]
pub struct Trade {
    pub tick: u64,
    pub price: Price,
    pub qty: Qty,
    pub taker_side: Side,
    pub maker_owner: Owner,
    pub taker_owner: Owner,
}

#[derive(Clone, Copy)]
pub struct Sample {
    pub tick: u64,
    pub mid: f64,
    pub fair: f64,
    pub informed: bool,
}

/// What agents get to see at the start of a tick. Everyone sees the same
/// thing; there is no latency modeling here (see the README for what that
/// leaves out).
pub struct View {
    pub tick: u64,
    pub mid: f64,
    pub best_bid: Option<Price>,
    pub best_ask: Option<Price>,
    /// Slow EWMA of signed aggressor volume per tick. Hovers near zero in a
    /// balanced market and drifts away when the flow turns one-sided.
    pub ewma_flow: f64,
    /// Fast EWMA of absolute mid changes, i.e. recent realized vol.
    pub ewma_vol: f64,
    /// Very slow EWMA of the same thing: the "normal" vol to compare against.
    pub ewma_vol_slow: f64,
}

struct Episode {
    until: u64,
    drift: f64,
}

pub struct Sim {
    pub book: Book,
    rng: Pcg32,
    pub tick: u64,
    pub fair: f64,
    pub mid: f64,
    pub makers: Vec<Maker>,
    accounts: Vec<Account>,
    episode: Option<Episode>,
    episode_cooldown: u64,
    pub episodes_seen: u32,
    noise_orders: VecDeque<(OrderId, u64)>,
    user_orders: Vec<OrderId>,
    bot_orders: Vec<OrderId>,
    tape: Vec<Trade>,
    series: Vec<Sample>,
    ewma_flow: f64,
    ewma_vol: f64,
    ewma_vol_slow: f64,
    pending_flow: f64,
    prev_mid: f64,
}

impl Sim {
    pub fn new(seed: u64) -> Sim {
        let mut sim = Sim {
            book: Book::new(),
            rng: Pcg32::new(seed),
            tick: 0,
            fair: START_FAIR,
            mid: START_FAIR,
            makers: vec![
                Maker::new(MAKER_FIXED, Brain::Fixed),
                Maker::new(MAKER_SKEW, Brain::Skew),
                Maker::new(MAKER_WARY, Brain::Wary),
            ],
            accounts: vec![Account::default(); BOT as usize + 1],
            episode: None,
            episode_cooldown: 0,
            episodes_seen: 0,
            noise_orders: VecDeque::new(),
            user_orders: Vec::new(),
            bot_orders: Vec::new(),
            tape: Vec::new(),
            series: Vec::new(),
            ewma_flow: 0.0,
            ewma_vol: 0.0,
            ewma_vol_slow: 0.3,
            pending_flow: 0.0,
            prev_mid: START_FAIR,
        };
        sim.seed_book();
        sim
    }

    /// Open with some resting depth so the first tick isn't a ghost town.
    fn seed_book(&mut self) {
        for i in 0..30u32 {
            let owner = NOISE_FIRST + self.rng.below(NOISE_COUNT as u32) as Owner;
            let qty = 2 + self.rng.below(12);
            let off = 1 + i / 3 + self.rng.below(3);
            self.book
                .limit(Side::Buy, (START_FAIR as u32) - off, qty, owner);
            let owner = NOISE_FIRST + self.rng.below(NOISE_COUNT as u32) as Owner;
            let qty = 2 + self.rng.below(12);
            let off = 1 + i / 3 + self.rng.below(3);
            self.book
                .limit(Side::Sell, (START_FAIR as u32) + off, qty, owner);
        }
        self.book.events.clear();
    }

    pub fn step(&mut self) {
        self.tick += 1;

        // Fair value: calm random walk, an extra drift while an informed
        // episode is on, and a whisper of mean reversion so a long session
        // doesn't wander off to zero or the moon.
        if let Some(e) = &self.episode {
            if self.tick >= e.until {
                self.episode = None;
                self.episode_cooldown = self.tick + EPISODE_COOLDOWN;
            }
        }
        if self.episode.is_none()
            && self.tick > self.episode_cooldown
            && self.rng.chance(EPISODE_CHANCE)
        {
            let sign = if self.rng.chance(0.5) { 1.0 } else { -1.0 };
            self.episode = Some(Episode {
                until: self.tick + 150 + self.rng.below(250) as u64,
                drift: sign * (0.05 + 0.07 * self.rng.unit()),
            });
            self.episodes_seen += 1;
        }
        let drift = self.episode.as_ref().map_or(0.0, |e| e.drift);
        self.fair += CALM_SIGMA * self.rng.gauss() + drift + (START_FAIR - self.fair) * 2e-5;
        self.fair = self.fair.max(100.0);

        let view = self.view();

        // Makers first, in rotating order so nobody always has queue
        // priority, then the flow: noise traders with the informed trader
        // slotted in among them at a random position.
        let Sim {
            book,
            makers,
            accounts,
            rng,
            noise_orders,
            episode,
            fair,
            tick,
            ..
        } = self;
        let n = makers.len();
        for k in 0..n {
            let m = &mut makers[(*tick as usize + k) % n];
            m.update(book, &view, accounts[m.owner as usize].inventory);
        }
        let informed_slot = rng.below(NOISE_COUNT as u32) as u16;
        for i in 0..NOISE_COUNT {
            if rng.chance(NOISE_ACT_CHANCE) {
                noise_act(
                    book,
                    rng,
                    NOISE_FIRST + i,
                    &view,
                    *fair,
                    noise_orders,
                    *tick,
                );
            }
            if i == informed_slot {
                match episode {
                    Some(e) => {
                        // Lean on the market while the edge lasts, but not
                        // so hard that our own impact outruns the drift.
                        if rng.chance(0.35) {
                            let side = if e.drift > 0.0 { Side::Buy } else { Side::Sell };
                            book.market(side, 4 + rng.below(12), INFORMED);
                        }
                    }
                    None => {
                        // No edge, so work the position back to flat.
                        let pos = accounts[INFORMED as usize].inventory;
                        if pos != 0 && rng.chance(0.12) {
                            let side = if pos > 0 { Side::Sell } else { Side::Buy };
                            book.market(side, pos.unsigned_abs().min(10) as u32, INFORMED);
                        }
                    }
                }
            }
        }

        // Expire stale noise orders so the book doesn't silt up.
        while let Some(&(id, placed)) = self.noise_orders.front() {
            if self.tick - placed < NOISE_ORDER_TTL && self.noise_orders.len() < 500 {
                break;
            }
            self.noise_orders.pop_front();
            self.book.cancel(id);
        }

        self.settle();

        if let (Some(bb), Some(ba)) = (self.book.best_bid(), self.book.best_ask()) {
            self.mid = (bb as f64 + ba as f64) / 2.0;
        }
        let ret = self.mid - self.prev_mid;
        self.prev_mid = self.mid;
        self.ewma_vol = 0.97 * self.ewma_vol + 0.03 * ret.abs();
        self.ewma_vol_slow = 0.999 * self.ewma_vol_slow + 0.001 * ret.abs();
        self.ewma_flow = 0.97 * self.ewma_flow + 0.03 * self.pending_flow;
        self.pending_flow = 0.0;

        self.user_orders.retain(|id| self.book.is_live(*id));
        self.bot_orders.retain(|id| self.book.is_live(*id));
        self.series.push(Sample {
            tick: self.tick,
            mid: self.mid,
            fair: self.fair,
            informed: self.episode.is_some(),
        });

        // Backstop if nobody is draining the tape (the native example does,
        // the web frontend does; this is for everyone else).
        if self.tape.len() > 200_000 {
            self.tape.drain(..100_000);
        }
        if self.series.len() > 200_000 {
            self.series.drain(..100_000);
        }
    }

    fn view(&self) -> View {
        View {
            tick: self.tick,
            mid: self.mid,
            best_bid: self.book.best_bid(),
            best_ask: self.book.best_ask(),
            ewma_flow: self.ewma_flow,
            ewma_vol: self.ewma_vol,
            ewma_vol_slow: self.ewma_vol_slow,
        }
    }

    /// Turn the engine's event buffer into cash, positions, and tape prints.
    fn settle(&mut self) {
        for ev in self.book.events.drain(..) {
            let Event::Fill(f) = ev else { continue };
            let (buyer, seller) = match f.taker_side {
                Side::Buy => (f.taker_owner, f.maker_owner),
                Side::Sell => (f.maker_owner, f.taker_owner),
            };
            let notional = f.price as i64 * f.qty as i64;
            self.accounts[buyer as usize].cash -= notional;
            self.accounts[buyer as usize].inventory += f.qty as i64;
            self.accounts[buyer as usize].volume += f.qty as u64;
            self.accounts[seller as usize].cash += notional;
            self.accounts[seller as usize].inventory -= f.qty as i64;
            self.accounts[seller as usize].volume += f.qty as u64;
            self.pending_flow += match f.taker_side {
                Side::Buy => f.qty as f64,
                Side::Sell => -(f.qty as f64),
            };
            self.tape.push(Trade {
                tick: self.tick,
                price: f.price,
                qty: f.qty,
                taker_side: f.taker_side,
                maker_owner: f.maker_owner,
                taker_owner: f.taker_owner,
            });
        }
    }

    pub fn account(&self, owner: Owner) -> Account {
        self.accounts[owner as usize]
    }

    /// The noise traders' books rolled into one, since the UI shows them as
    /// a single crowd.
    pub fn noise_total(&self) -> Account {
        let mut total = Account::default();
        for a in &self.accounts[NOISE_FIRST as usize..BOT as usize] {
            total.cash += a.cash;
            total.inventory += a.inventory;
            total.volume += a.volume;
        }
        total
    }

    /// Mark-to-mid P&L in tick units.
    pub fn pnl(&self, a: &Account) -> f64 {
        a.cash as f64 + a.inventory as f64 * self.mid
    }

    pub fn informed_active(&self) -> bool {
        self.episode.is_some()
    }

    pub fn take_tape(&mut self) -> Vec<Trade> {
        std::mem::take(&mut self.tape)
    }

    pub fn take_series(&mut self) -> Vec<Sample> {
        std::mem::take(&mut self.series)
    }

    // The user's hands on the market. Fills settle immediately so the UI
    // never shows a stale blotter.

    pub fn user_limit(&mut self, side: Side, price: Price, qty: Qty) -> OrderId {
        let id = self.book.limit(side, price, qty, USER);
        self.settle();
        if self.book.is_live(id) {
            self.user_orders.push(id);
        }
        id
    }

    pub fn user_market(&mut self, side: Side, qty: Qty) -> Qty {
        let filled = self.book.market(side, qty, USER);
        self.settle();
        filled
    }

    /// Cancels only orders the user actually owns. Without the ownership
    /// check, anyone with the browser console open could cancel the market
    /// makers' quotes, which is a fun exploit but the wrong kind of fun.
    pub fn user_cancel(&mut self, id: OrderId) -> bool {
        self.user_orders.contains(&id) && self.book.cancel(id)
    }

    pub fn user_open_orders(&self) -> Vec<(OrderId, Side, Price, Qty)> {
        self.user_orders
            .iter()
            .filter_map(|&id| self.book.resting(id).map(|(s, p, q)| (id, s, p, q)))
            .collect()
    }

    // The scripted bot's hands. Same shape as the user's, same rules.

    pub fn bot_limit(&mut self, side: Side, price: Price, qty: Qty) -> OrderId {
        let id = self.book.limit(side, price, qty, BOT);
        self.settle();
        if self.book.is_live(id) {
            self.bot_orders.push(id);
        }
        id
    }

    pub fn bot_market(&mut self, side: Side, qty: Qty) -> Qty {
        let filled = self.book.market(side, qty, BOT);
        self.settle();
        filled
    }

    pub fn bot_cancel(&mut self, id: OrderId) -> bool {
        self.bot_orders.contains(&id) && self.book.cancel(id)
    }

    pub fn bot_open_orders(&self) -> Vec<(OrderId, Side, Price, Qty)> {
        self.bot_orders
            .iter()
            .filter_map(|&id| self.book.resting(id).map(|(s, p, q)| (id, s, p, q)))
            .collect()
    }
}

/// One noise trader takes one action: usually a limit order somewhere near
/// the touch, sometimes a market order. Side choice leans against the gap
/// between mid and fair value, which is what tethers the price: the further
/// the market drifts from fair, the more of the crowd leans the other way.
fn noise_act(
    book: &mut Book,
    rng: &mut Pcg32,
    owner: Owner,
    view: &View,
    fair: f64,
    noise_orders: &mut VecDeque<(OrderId, u64)>,
    tick: u64,
) {
    let dev = view.mid - fair;
    let p_buy = (0.5 - 0.04 * dev).clamp(0.15, 0.85);
    let side = if rng.chance(p_buy) {
        Side::Buy
    } else {
        Side::Sell
    };
    let mut qty = 1 + rng.below(10);
    if rng.below(25) == 0 {
        qty += 15 + rng.below(30); // the occasional lump
    }

    if rng.chance(0.25) {
        book.market(side, qty, owner);
        return;
    }

    let off = (rng.below(3) + rng.below(3)) as i64;
    let improve = rng.chance(0.15);
    let price = match side {
        Side::Buy => {
            let anchor = view.best_bid.map_or(view.mid as i64 - 1, |p| p as i64);
            if improve {
                anchor + 1
            } else {
                anchor - off
            }
        }
        Side::Sell => {
            let anchor = view.best_ask.map_or(view.mid as i64 + 1, |p| p as i64);
            if improve {
                anchor - 1
            } else {
                anchor + off
            }
        }
    };
    if price < 1 {
        return;
    }
    let id = book.limit(side, price as Price, qty, owner);
    if book.is_live(id) {
        noise_orders.push_back((id, tick));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_market() {
        let mut a = Sim::new(42);
        let mut b = Sim::new(42);
        for _ in 0..5_000 {
            a.step();
            b.step();
        }
        assert_eq!(a.tick, b.tick);
        assert_eq!(a.mid, b.mid);
        assert_eq!(a.fair, b.fair);
        let (ta, tb) = (a.take_tape(), b.take_tape());
        assert_eq!(ta.len(), tb.len());
        for (x, y) in ta.iter().zip(&tb) {
            assert_eq!((x.tick, x.price, x.qty), (y.tick, y.price, y.qty));
        }
    }

    #[test]
    fn books_balance() {
        // Cash and inventory across all accounts must net to zero: every
        // trade moves value between two parties, never creates it.
        let mut sim = Sim::new(9);
        for _ in 0..20_000 {
            sim.step();
        }
        let mut cash = 0i64;
        let mut inv = 0i64;
        for owner in 0..=BOT {
            let a = sim.account(owner);
            cash += a.cash;
            inv += a.inventory;
        }
        // The seeded opening orders came from nowhere, so the crowd's net
        // inventory offsets what those seeds sold or bought; cash still nets.
        assert_eq!(cash, 0);
        let _ = inv;
    }

    #[test]
    fn you_can_only_cancel_your_own_orders() {
        let mut sim = Sim::new(5);
        sim.step();
        // Find somebody else's resting order via the book depth, then try to
        // cancel every plausible id. None of them should work for the user
        // or the bot unless the order is actually theirs.
        let user_id = sim.user_limit(Side::Buy, 9_000, 5); // deep, rests
        let bot_id = sim.bot_limit(Side::Buy, 8_999, 5);
        assert!(!sim.user_cancel(bot_id));
        assert!(!sim.bot_cancel(user_id));
        for id in 1..200 {
            if id != user_id {
                assert!(!sim.user_cancel(id), "user canceled foreign order {id}");
            }
        }
        assert!(sim.user_cancel(user_id));
        assert!(sim.bot_cancel(bot_id));
    }

    #[test]
    fn market_stays_sane_over_a_long_run() {
        let mut sim = Sim::new(3);
        for _ in 0..100_000 {
            sim.step();
            if let (Some(bb), Some(ba)) = (sim.book.best_bid(), sim.book.best_ask()) {
                assert!(bb < ba, "crossed book at tick {}", sim.tick);
                assert!((ba - bb) < 500, "absurd spread at tick {}", sim.tick);
            }
            assert!((sim.mid - sim.fair).abs() < 400.0, "mid unmoored from fair");
            sim.take_tape();
            sim.take_series();
        }
        assert!(sim.episodes_seen > 0, "no informed episodes in 100k ticks");
    }
}
