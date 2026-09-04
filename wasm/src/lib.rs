//! Thin wasm-bindgen wrapper around the sim. Everything crosses the JS
//! boundary as flat arrays of f64 with documented layouts, which keeps the
//! per-frame overhead tiny and this crate free of serialization machinery.

use pit_engine::Side;
use pit_sim::Sim;
use wasm_bindgen::prelude::*;

fn side(buy: bool) -> Side {
    if buy {
        Side::Buy
    } else {
        Side::Sell
    }
}

fn owner_code(owner: u16) -> f64 {
    // The frontend maps these to names; noise traders collapse to one code.
    match owner {
        pit_sim::USER => 1.0,
        pit_sim::INFORMED => 2.0,
        pit_sim::MAKER_FIXED => 3.0,
        pit_sim::MAKER_SKEW => 4.0,
        pit_sim::MAKER_WARY => 5.0,
        pit_sim::BOT => 7.0,
        _ => 6.0,
    }
}

#[wasm_bindgen]
pub struct PitSim {
    sim: Sim,
}

#[wasm_bindgen]
impl PitSim {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32) -> PitSim {
        PitSim {
            sim: Sim::new(seed as u64),
        }
    }

    pub fn step(&mut self, ticks: u32) {
        for _ in 0..ticks {
            self.sim.step();
        }
    }

    /// Market condition dials: calm volatility and informed-episode
    /// frequency, both as multiples of the tuned defaults.
    pub fn set_conditions(&mut self, vol_mult: f64, episode_mult: f64) {
        self.sim.set_conditions(vol_mult, episode_mult);
    }

    /// [tick, bestBid, bestAsk, mid, fair, informedActive,
    ///  wary quoting (0 = pulled), halted]
    pub fn status(&self) -> Vec<f64> {
        let bb = self.sim.book.best_bid().map_or(0.0, |p| p as f64);
        let ba = self.sim.book.best_ask().map_or(0.0, |p| p as f64);
        let wary_in = self
            .sim
            .makers
            .iter()
            .find(|m| m.owner == pit_sim::MAKER_WARY)
            .map_or(1.0, |m| if m.is_pulled(self.sim.tick) { 0.0 } else { 1.0 });
        vec![
            self.sim.tick as f64,
            bb,
            ba,
            self.sim.mid,
            self.sim.fair,
            if self.sim.informed_active() { 1.0 } else { 0.0 },
            wary_in,
            if self.sim.halted() { 1.0 } else { 0.0 },
        ]
    }

    /// `levels` price levels per side: [bidPrice, bidQty] * levels then
    /// [askPrice, askQty] * levels, best first, zero-padded.
    pub fn depth(&self, levels: usize) -> Vec<f64> {
        let mut out = Vec::with_capacity(levels * 4);
        for s in [Side::Buy, Side::Sell] {
            let d = self.sim.book.depth(s, levels);
            for i in 0..levels {
                match d.get(i) {
                    Some((p, q)) => {
                        out.push(*p as f64);
                        out.push(*q as f64);
                    }
                    None => {
                        out.push(0.0);
                        out.push(0.0);
                    }
                }
            }
        }
        out
    }

    /// Trades since the last call:
    /// [tick, price, qty, takerIsBuy, makerOwner, takerOwner] each.
    pub fn trades(&mut self) -> Vec<f64> {
        let tape = self.sim.take_tape();
        let mut out = Vec::with_capacity(tape.len() * 6);
        for t in tape {
            out.push(t.tick as f64);
            out.push(t.price as f64);
            out.push(t.qty as f64);
            out.push(if t.taker_side == Side::Buy { 1.0 } else { 0.0 });
            out.push(owner_code(t.maker_owner));
            out.push(owner_code(t.taker_owner));
        }
        out
    }

    /// Mid/fair samples since the last call: [tick, mid, fair, informed] each.
    pub fn series(&mut self) -> Vec<f64> {
        let samples = self.sim.take_series();
        let mut out = Vec::with_capacity(samples.len() * 4);
        for s in samples {
            out.push(s.tick as f64);
            out.push(s.mid);
            out.push(s.fair);
            out.push(if s.informed { 1.0 } else { 0.0 });
        }
        out
    }

    /// Per-desk book state: [cash, inventory, volume, pnl] for the user, the
    /// scripted bot, the informed trader, the three makers, and the noise
    /// crowd, in that order. Cash and pnl are in tick units.
    pub fn accounts(&self) -> Vec<f64> {
        let mut out = Vec::with_capacity(7 * 4);
        let owners = [
            pit_sim::USER,
            pit_sim::BOT,
            pit_sim::INFORMED,
            pit_sim::MAKER_FIXED,
            pit_sim::MAKER_SKEW,
            pit_sim::MAKER_WARY,
        ];
        for o in owners {
            let a = self.sim.account(o);
            out.push(a.cash as f64);
            out.push(a.inventory as f64);
            out.push(a.volume as f64);
            out.push(self.sim.pnl(&a));
        }
        let a = self.sim.noise_total();
        out.push(a.cash as f64);
        out.push(a.inventory as f64);
        out.push(a.volume as f64);
        out.push(self.sim.pnl(&a));
        out
    }

    // User actions. Ids travel as f64, which is exact well past any id this
    // sim will ever hand out.

    pub fn user_limit(&mut self, buy: bool, price: u32, qty: u32) -> f64 {
        self.sim.user_limit(side(buy), price, qty) as f64
    }

    pub fn user_market(&mut self, buy: bool, qty: u32) -> f64 {
        self.sim.user_market(side(buy), qty) as f64
    }

    pub fn user_cancel(&mut self, id: f64) -> bool {
        self.sim.user_cancel(id as u64)
    }

    /// [id, isBuy, price, qty] per open user order.
    pub fn user_orders(&self) -> Vec<f64> {
        let mut out = Vec::new();
        for (id, s, p, q) in self.sim.user_open_orders() {
            out.push(id as f64);
            out.push(if s == Side::Buy { 1.0 } else { 0.0 });
            out.push(p as f64);
            out.push(q as f64);
        }
        out
    }

    // The bot lab's hands: identical shape to the user's, separate desk.

    pub fn bot_limit(&mut self, buy: bool, price: u32, qty: u32) -> f64 {
        self.sim.bot_limit(side(buy), price, qty) as f64
    }

    pub fn bot_market(&mut self, buy: bool, qty: u32) -> f64 {
        self.sim.bot_market(side(buy), qty) as f64
    }

    pub fn bot_cancel(&mut self, id: f64) -> bool {
        self.sim.bot_cancel(id as u64)
    }

    /// [id, isBuy, price, qty] per open bot order.
    pub fn bot_orders(&self) -> Vec<f64> {
        let mut out = Vec::new();
        for (id, s, p, q) in self.sim.bot_open_orders() {
            out.push(id as f64);
            out.push(if s == Side::Buy { 1.0 } else { 0.0 });
            out.push(p as f64);
            out.push(q as f64);
        }
        out
    }
}
