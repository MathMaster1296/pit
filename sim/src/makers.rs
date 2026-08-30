use pit_engine::{Book, OrderId, Price, Qty, Side};

use crate::View;

/// The three market makers. Same plumbing, different brains:
///
/// * `Fixed` quotes a constant spread around the mid and never thinks about
///   anything else. It is the control group.
/// * `Skew` shifts its quotes against its inventory, so a growing long
///   position drags both quotes down until someone takes it off their hands.
/// * `Wary` does the inventory skew and also watches order flow. One-sided
///   aggressive flow usually means someone knows something, so it widens as
///   flow gets lopsided and pulls its quotes entirely past a threshold.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Brain {
    Fixed,
    Skew,
    Wary,
}

pub struct Maker {
    pub owner: u16,
    pub brain: Brain,
    pub size: Qty,
    bid: Option<OrderId>,
    ask: Option<OrderId>,
    pulled_until: u64,
}

// Tuning constants. These were arrived at by running `cargo run --release
// --example session` and staring at the P&L table, not by any deep theory.
const HALF_SPREAD: f64 = 1.2;
const SKEW_PER_LOT: f64 = 0.08;
const INVENTORY_CAP: i64 = 60;
const WARY_BASE: f64 = 1.2;
const WARY_VOL_MULT: f64 = 3.0;
const WARY_FLOW_MULT: f64 = 0.4;
const WARY_PULL_AT: f64 = 2.6;
const WARY_PULL_TICKS: u64 = 40;

impl Maker {
    pub fn new(owner: u16, brain: Brain) -> Maker {
        Maker {
            owner,
            brain,
            size: if brain == Brain::Wary { 12 } else { 15 },
            bid: None,
            ask: None,
            pulled_until: 0,
        }
    }

    /// True while `Wary` has stepped away from the market.
    pub fn is_pulled(&self, tick: u64) -> bool {
        tick < self.pulled_until
    }

    pub fn update(&mut self, book: &mut Book, view: &View, inventory: i64) {
        if self.brain == Brain::Wary {
            if view.ewma_flow.abs() > WARY_PULL_AT {
                self.pulled_until = view.tick + WARY_PULL_TICKS;
            }
            if self.is_pulled(view.tick) {
                self.pull(book);
                return;
            }
        }

        let inv = inventory as f64;
        let (center, half) = match self.brain {
            Brain::Fixed => (view.mid, HALF_SPREAD),
            Brain::Skew => (view.mid - inv * SKEW_PER_LOT, HALF_SPREAD),
            Brain::Wary => {
                // Widen on vol above its long-run baseline and on one-sided
                // flow, not on vol per se: a normal amount of chop is what
                // the base spread is for.
                let excess_vol = (view.ewma_vol - view.ewma_vol_slow).max(0.0);
                (
                    view.mid - inv * SKEW_PER_LOT,
                    WARY_BASE + WARY_VOL_MULT * excess_vol + WARY_FLOW_MULT * view.ewma_flow.abs(),
                )
            }
        };

        let mut bid_px = (center - half).floor() as i64;
        let mut ask_px = (center + half).ceil() as i64;

        // Stay passive: never quote through the other side of the book.
        // Taking liquidity is not this desk's job.
        if let Some(ba) = view.best_ask {
            bid_px = bid_px.min(ba as i64 - 1);
        }
        if let Some(bb) = view.best_bid {
            ask_px = ask_px.max(bb as i64 + 1);
        }
        if ask_px <= bid_px {
            ask_px = bid_px + 1;
        }

        // Past the inventory cap, quote only the side that sheds risk.
        let quote_bid = inventory < INVENTORY_CAP && bid_px > 0;
        let quote_ask = inventory > -INVENTORY_CAP;

        self.refresh_side(book, Side::Buy, quote_bid, bid_px as Price);
        self.refresh_side(book, Side::Sell, quote_ask, ask_px as Price);
    }

    /// Cancel-and-replace, but only when the quote is actually stale: wrong
    /// price, mostly eaten, or missing. Requoting every tick would churn the
    /// queue and forfeit time priority for no reason.
    fn refresh_side(&mut self, book: &mut Book, side: Side, want: bool, price: Price) {
        let slot = match side {
            Side::Buy => &mut self.bid,
            Side::Sell => &mut self.ask,
        };
        if let Some(id) = *slot {
            match book.resting(id) {
                Some((_, px, qty)) if want && px == price && qty * 2 >= self.size => return,
                Some(_) => {
                    book.cancel(id);
                    *slot = None;
                }
                None => *slot = None,
            }
        }
        if want {
            let id = book.limit(side, price, self.size, self.owner);
            if book.is_live(id) {
                *slot = Some(id);
            }
        }
    }

    fn pull(&mut self, book: &mut Book) {
        for slot in [&mut self.bid, &mut self.ask] {
            if let Some(id) = slot.take() {
                book.cancel(id);
            }
        }
    }
}
