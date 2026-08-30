//! Throughput on a realistic mixed workload: mostly limit orders placed near
//! the touch, a healthy share of cancels, some market orders. Run with
//! `cargo bench` and read ops/sec off the criterion output.

use criterion::{criterion_group, criterion_main, BatchSize, Criterion, Throughput};
use pit_engine::{Book, Price, Qty, Side};

const OPS: usize = 100_000;

enum Op {
    Limit(Side, Price, Qty),
    Market(Side, Qty),
    Cancel(usize), // index into the ids seen so far
}

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

fn workload() -> Vec<Op> {
    let mut rng = Rng(0x5eed);
    let mut ops = Vec::with_capacity(OPS);
    let mut center: i64 = 10_000;
    for i in 0..OPS {
        // Let the center wander so price levels churn like a real book.
        center += rng.below(3) as i64 - 1;
        let side = if rng.below(2) == 0 {
            Side::Buy
        } else {
            Side::Sell
        };
        // Geometric-ish offset from the touch: most orders land close.
        let off = rng.below(4) + rng.below(4);
        let price = match side {
            Side::Buy => center - 1 - off as i64,
            Side::Sell => center + 1 + off as i64,
        } as Price;
        let qty = (1 + rng.below(100)) as Qty;
        ops.push(match rng.below(10) {
            0..=5 => Op::Limit(side, price, qty),
            6 => Op::Market(side, 1 + qty / 4),
            _ => Op::Cancel(rng.below(i.max(1) as u64) as usize),
        });
    }
    ops
}

fn run(ops: &[Op]) -> u64 {
    let mut book = Book::new();
    let mut ids = Vec::with_capacity(ops.len());
    let mut trades = 0u64;
    for op in ops {
        match op {
            Op::Limit(side, price, qty) => {
                ids.push(book.limit(*side, *price, *qty, (ids.len() % 7 + 1) as u16));
            }
            Op::Market(side, qty) => {
                book.market(*side, *qty, 99);
            }
            Op::Cancel(i) => {
                if let Some(id) = ids.get(*i) {
                    book.cancel(*id);
                }
            }
        }
        trades += book.events.len() as u64;
        book.events.clear();
    }
    trades
}

fn bench(c: &mut Criterion) {
    let ops = workload();
    let mut g = c.benchmark_group("book");
    g.throughput(Throughput::Elements(OPS as u64));
    g.bench_function("mixed_workload", |b| {
        b.iter_batched(|| &ops, |ops| run(ops), BatchSize::SmallInput)
    });
    g.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
