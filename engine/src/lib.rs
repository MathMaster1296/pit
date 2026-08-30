//! A price-time priority limit order book.
//!
//! Prices are integer ticks and quantities are integer lots, because that is
//! what real matching engines use and it keeps floating point out of the hot
//! path. Matching pushes events into a buffer that the caller drains, so the
//! steady state does no allocation beyond the book structures themselves.

mod book;

pub use book::Book;

pub type Price = u32;
pub type Qty = u32;
pub type OrderId = u64;

/// Small integer identifying who owns an order. The engine only uses it for
/// self-match prevention and for tagging fills; everything else about agents
/// lives a layer up, in the sim.
pub type Owner = u16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn flip(self) -> Side {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }
}

/// One trade. The maker is the resting order, the taker is the incoming one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fill {
    pub price: Price,
    pub qty: Qty,
    pub maker: OrderId,
    pub maker_owner: Owner,
    pub taker: OrderId,
    pub taker_owner: Owner,
    pub taker_side: Side,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Fill(Fill),
    /// An incoming order would have traded against the same owner's resting
    /// order. We cancel the resting order and keep matching, which is one of
    /// the standard self-trade prevention policies (cancel oldest).
    SelfMatch {
        canceled: OrderId,
        owner: Owner,
        lost_qty: Qty,
    },
}
