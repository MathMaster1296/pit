//! Run a long session and print what everyone made. This is the tuning
//! harness: change a constant, run a few seeds, watch the table.
//!
//!     cargo run --release --example session -- <seed> <ticks>

use pit_sim::{Sim, INFORMED, MAKER_FIXED, MAKER_SKEW, MAKER_WARY};

fn main() {
    let mut args = std::env::args().skip(1);
    let seed: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(7);
    let ticks: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(500_000);

    let mut sim = Sim::new(seed);
    let mut spread_sum = 0u64;
    let mut spread_n = 0u64;
    let mut trades = 0u64;
    let mut volume = 0u64;

    for _ in 0..ticks {
        sim.step();
        if let (Some(bb), Some(ba)) = (sim.book.best_bid(), sim.book.best_ask()) {
            spread_sum += (ba - bb) as u64;
            spread_n += 1;
        }
        for t in sim.take_tape() {
            trades += 1;
            volume += t.qty as u64;
        }
        sim.take_series();
    }

    println!(
        "seed {seed}, {ticks} ticks, {} informed episodes",
        sim.episodes_seen
    );
    println!(
        "{trades} trades, {volume} lots, avg spread {:.2} ticks, final mid {:.2}",
        spread_sum as f64 / spread_n as f64,
        sim.mid / 100.0
    );
    println!();
    println!(
        "{:<12} {:>10} {:>8} {:>12}",
        "desk", "volume", "pos", "pnl ($)"
    );
    let rows = [
        ("informed", INFORMED),
        ("mm-fixed", MAKER_FIXED),
        ("mm-skew", MAKER_SKEW),
        ("mm-wary", MAKER_WARY),
    ];
    for (name, owner) in rows {
        let a = sim.account(owner);
        println!(
            "{:<12} {:>10} {:>8} {:>12.2}",
            name,
            a.volume,
            a.inventory,
            sim.pnl(&a) / 100.0
        );
    }
    let a = sim.noise_total();
    println!(
        "{:<12} {:>10} {:>8} {:>12.2}",
        "noise crowd",
        a.volume,
        a.inventory,
        sim.pnl(&a) / 100.0
    );
}
