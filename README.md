# pit

A tiny exchange that runs in your browser: a real limit order book matching
engine written in Rust, compiled to WebAssembly, with three market makers, a
crowd of noise traders, and an occasional informed trader who knows where the
price is going before everyone else.

**Live demo: [mathmaster1296.github.io/pit](https://mathmaster1296.github.io/pit)**

You get a desk too. Click the book to rest limit orders, hit the market
buttons, and see if you can stay ahead of the bots. Runs are deterministic:
the same seed always produces the same market, tick for tick, so any run can
be replayed by sharing its URL.

## Why this exists

I wanted to see adverse selection happen instead of reading about it. The
demo is built around one idea: market makers earn the spread from uninformed
flow and lose it to informed flow, and how they handle that is most of what
separates them.

So the sim has a hidden fair value following a random walk, and every so
often an informed trader shows up who can see where it is headed. The three
makers respond differently:

* **mm-fixed** quotes a constant spread around the mid. It has no idea the
  informed trader exists.
* **mm-skew** shifts its quotes against its inventory, the textbook first
  step (the idea dates to Avellaneda and Stoikov's 2008 paper, though this
  version is a linear skew, not the closed-form solution).
* **mm-wary** skews too, and also watches signed order flow and short-term
  volatility against their long-run baselines. When flow turns one-sided it
  widens, and past a threshold it pulls its quotes entirely.

Over a long session mm-fixed bleeds, mm-skew roughly breaks even, and
mm-wary, despite trading a quarter of the volume, is usually the only maker
in the green. Nothing scripts that outcome; it falls out of who gets picked
off during the shaded stretches. Here is a 500k-tick run on seed 7:

```
seed 7, 500000 ticks, 204 informed episodes
471386 trades, 1870262 lots, avg spread 1.87 ticks, final mid 99.21

desk             volume      pos      pnl ($)
informed         366097     -485     22657.37
mm-fixed         104972       46      -625.81
mm-skew          145309        3        82.32
mm-wary           34493        3       237.29
noise crowd     3089653      433    -22351.17
```

The noise crowd pays for everything, which is also the textbook answer to
who funds the market making industry.

## The engine

`engine/` is a standalone price-time priority matching engine with no
dependencies. Limit, market, and immediate-or-cancel orders, cancels, partial
fills, and self-match prevention (cancel-oldest, the same policy several real
exchanges offer). Prices are integer ticks, quantities integer lots, and the
matching loop allocates nothing in steady state.

The book is two `BTreeMap`s of FIFO queues plus an id index for cancels. A
production engine would use flatter structures, but this keeps the code
readable, and it is fast enough that the browser sim spends most of its time
elsewhere: criterion measures 13 to 15 million operations per second (about
70ns each) on an Apple M4, on a mixed workload of limits near the touch,
cancels, and market orders. Inside the browser, a full sim tick, which
includes all 24 agents deciding and acting, runs in about 0.9 microseconds.

Correctness is tested two ways:

* unit tests for the matching semantics you would expect (FIFO within a
  level, price improvement goes to the taker, IOC never rests, and so on),
* a differential test that replays 200k random operations through the engine
  and through a 100-line brute-force reference book, and asserts the two
  produce identical event streams. The reference is slow and too simple to
  be wrong, which is the point. If they ever disagree, the failing seed
  prints so the case can be replayed.

## The sim

`sim/` puts a market on the engine. Twenty noise traders fire limit and
market orders with a weak lean toward fair value, which is what tethers the
price. The informed trader wakes up every couple of thousand ticks, trades
aggressively in the direction of the coming drift, then works its position
back to flat when the edge is gone. Randomness comes from one hand-rolled
PCG32, so a seed fully determines the run on every platform, including wasm.

The tuning constants in `sim/src/makers.rs` were arrived at by running
`cargo run --release --example session` across seeds and staring at the P&L
table until the dynamics looked like the microstructure story they are meant
to illustrate. They are not calibrated to any real market, and the point
survives reasonable retuning: whoever quotes tightest with the least
information pays the most.

## Running it

Native tests and benchmarks:

```
cargo test
cargo bench -p pit-engine
cargo run --release --example session -- 7 500000
```

The web frontend (needs [wasm-pack](https://rustwasm.github.io/wasm-pack/)):

```
wasm-pack build wasm --target web --release --out-dir ../web/pkg --no-typescript
python3 -m http.server -d web 8000
```

Then open http://localhost:8000. The frontend is plain ES modules and canvas,
no framework, no build step beyond the wasm.

## What it deliberately leaves out

There is no latency: every agent sees the book at the same instant, so there
is no queue racing and no speed advantage to model. There are no fees or
rebates, and only one instrument trades. The flow model is a toy, and the
informed trader's edge is artificial (it reads the future drift straight from
the simulator). The matching itself is not simplified, but everything around
it is, and numbers coming out of the sim describe this sim, not any real
market.

## Reading that pairs well with this

* Larry Harris, *Trading and Exchanges*, for the market structure vocabulary.
* Avellaneda and Stoikov, *High-frequency trading in a limit order book*
  (2008), for where mm-skew's idea comes from.
* The [LOBSTER](https://lobsterdata.com/) sample files, if you want to see
  what real order book data looks like next to this toy.

## License

MIT
