// The bot lab: visitors write a strategy in the page, and it trades on the
// same book as everyone else through its own desk. The code runs with
// new Function, which is fine here: it is the visitor's own browser, and the
// worst they can do is lose pretend money faster.

import { PitSim } from '../pkg/pit_wasm.js';
import { money } from './fmt.js';

const $ = (id) => document.getElementById(id);

const ACTION_CAP = 6; // per tick; a bot that needs more is a bug, not a desk
const QTY_CAP = 200;

export const PRESETS = {
  template: `// your bot runs once per simulation tick.
//
// view: { tick, bid, ask, mid, last, position, cash, pnl,
//         orders: [{id, side, price, qty}],   your open orders
//         trades: [{price, qty, side}],       prints from this tick
//         depth: { bids: [{price, qty}], asks: [...] } }  top 5 levels
// api:  { limit(side, price, qty), market(side, qty), cancel(id) }
//       side is 'buy' or 'sell', prices are integer ticks (cents)
// state: an object that survives between ticks, yours to use
//
// caps: ${ACTION_CAP} actions per tick, ${QTY_CAP} lots per order.
// an exception fires the bot. orders sent during a trading halt are
// rejected (they return 0). the latency dial makes your view stale
// by that many ticks; the rust desks all run at zero.
// "run a season" backtests this exact code. "share bot" makes a link.

// example: do nothing, profitably
`,

  'join the touch': `// quote both sides at the touch, size 5.
// simple, honest, and it will get picked off eventually. watch and learn.
const size = 5;
let haveBid = false;
let haveAsk = false;
for (const o of view.orders) {
  const stale = (o.side === 'buy' && o.price !== view.bid) ||
                (o.side === 'sell' && o.price !== view.ask);
  if (stale) { api.cancel(o.id); continue; }
  if (o.side === 'buy') haveBid = true;
  else haveAsk = true;
}
if (!haveBid && view.bid) api.limit('buy', view.bid, size);
if (!haveAsk && view.ask) api.limit('sell', view.ask, size);
`,

  'skew clone': `// a tiny mm-skew: lean your quotes against your inventory
// so a position never builds up. try changing skew and half.
const size = 5;
const half = 2;
const skew = 0.1;
const center = view.mid - view.position * skew;
const bid = Math.floor(center - half);
const ask = Math.ceil(center + half);
let haveBid = false;
let haveAsk = false;
for (const o of view.orders) {
  const want = o.side === 'buy' ? bid : ask;
  if (o.price !== want) { api.cancel(o.id); continue; }
  if (o.side === 'buy') haveBid = true;
  else haveAsk = true;
}
if (!haveBid && bid > 0) api.limit('buy', bid, size);
if (!haveAsk) api.limit('sell', ask, size);
`,

  momentum: `// read the tape: when the flow runs one-sided, go with it,
// and flatten when it goes quiet. this bot pays the spread on every
// trade, so it has to be right about direction to come out ahead.
state.flow = (state.flow ?? 0) * 0.97;
for (const t of view.trades) {
  state.flow += t.side === 'buy' ? t.qty : -t.qty;
}
if (state.flow > 12 && view.position < 60) api.market('buy', 5);
else if (state.flow < -12 && view.position > -60) api.market('sell', 5);
else if (Math.abs(state.flow) < 2 && view.position !== 0) {
  const back = Math.min(Math.abs(view.position), 5);
  api.market(view.position > 0 ? 'sell' : 'buy', back);
}
`,
};

function compile(code) {
  return new Function('view', 'api', 'state', `"use strict";\n${code}`);
}

// Bot code travels in the URL as base64url, after the seed and a pipe.
function encodeCode(code) {
  return btoa(unescape(encodeURIComponent(code)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeCode(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(b64)));
}

export class BotLab {
  constructor(getSim, notify) {
    this.getSim = getSim;
    this.notify = notify;
    this.fn = null;
    this.state = {};
    this.running = false;
    this.lag = { n: 0, buf: [] };

    let saved = null;
    try {
      saved = localStorage.getItem('pit-bot-code');
    } catch {
      // no storage, no saved bot
    }
    $('bot-code').value = saved || PRESETS.template;

    // A bot that arrived by link wins over the saved one.
    const linked = location.hash.slice(1).split('|')[1];
    if (linked) {
      try {
        $('bot-code').value = decodeCode(linked);
        this.status('a bot arrived with this link. read it before you hire it.', 'ok');
      } catch {
        this.status('the link carried a bot, but it did not decode', 'err');
      }
    }

    $('bot-preset').addEventListener('change', () => {
      const p = PRESETS[$('bot-preset').value];
      if (p) {
        $('bot-code').value = p;
        this.status('preset loaded, hit hire when ready');
      }
    });
    $('bot-latency').addEventListener('change', () => {
      this.lag = { n: Number($('bot-latency').value), buf: [] };
    });
    $('bot-run').addEventListener('click', () => {
      if (this.running) this.fire('fired. the desk is dark.');
      else this.hire();
    });
    $('bot-share').addEventListener('click', () => {
      const seed = location.hash.slice(1).split('|')[0] || '';
      const url = `${location.origin}${location.pathname}#${seed}|${encodeCode($('bot-code').value)}`;
      navigator.clipboard.writeText(url).then(
        () => this.notify('bot link copied. whoever opens it gets your exact code and seed.'),
        () => this.notify('could not reach the clipboard; the link is in the address bar after you hire'),
      );
    });
  }

  latency() {
    return Number($('bot-latency').value);
  }

  status(text, cls = '') {
    const el = $('bot-status');
    el.textContent = text;
    el.className = cls;
  }

  hire() {
    const code = $('bot-code').value;
    try {
      this.fn = compile(code);
    } catch (e) {
      this.status(`won't compile: ${e.message}`, 'err');
      return;
    }
    try {
      localStorage.setItem('pit-bot-code', code);
    } catch {
      // fine, it just won't survive a reload
    }
    this.state = {};
    this.lag = { n: this.latency(), buf: [] };
    this.running = true;
    $('bot-run').textContent = 'fire bot';
    this.status(
      this.lag.n ? `on the floor, ${this.lag.n} ticks behind the market` : 'on the floor',
      'ok',
    );
    this.notify('your bot is on the floor. watch its row in the desks table.');
  }

  fire(message) {
    this.running = false;
    $('bot-run').textContent = 'hire bot';
    if (message) this.status(message);
    const sim = this.getSim();
    if (!sim) return;
    const orders = sim.bot_orders();
    for (let i = 0; i < orders.length; i += 4) sim.bot_cancel(orders[i]);
  }

  onRestart() {
    // A new sim means the bot's orders and position are gone; its brain and
    // employment status carry over.
    this.state = {};
    this.lag.buf = [];
  }

  /// Called once per simulation tick with that tick's raw trade array.
  tick(rawTrades, lastPx) {
    if (!this.running || !this.fn) return;
    const err = runBotTick(this.getSim(), this.fn, this.state, rawTrades, lastPx, this.lag);
    if (err) {
      this.fire();
      this.status(`crashed and got fired: ${err}`, 'err');
      this.notify('your bot threw an exception and was escorted out');
    }
  }
}

function buildView(sim, rawTrades, lastPx) {
  const st = sim.status();
  const acct = sim.accounts();
  const rawOrders = sim.bot_orders();
  const rawDepth = sim.depth(5);

  const orders = [];
  for (let i = 0; i < rawOrders.length; i += 4) {
    orders.push({
      id: rawOrders[i],
      side: rawOrders[i + 1] === 1 ? 'buy' : 'sell',
      price: rawOrders[i + 2],
      qty: rawOrders[i + 3],
    });
  }
  const trades = [];
  for (let i = 0; i < rawTrades.length; i += 6) {
    trades.push({
      price: rawTrades[i + 1],
      qty: rawTrades[i + 2],
      side: rawTrades[i + 3] === 1 ? 'buy' : 'sell',
    });
  }
  const depth = { bids: [], asks: [] };
  const levels = rawDepth.length / 4;
  for (let i = 0; i < levels; i++) {
    if (rawDepth[i * 2] > 0) {
      depth.bids.push({ price: rawDepth[i * 2], qty: rawDepth[i * 2 + 1] });
    }
    if (rawDepth[(levels + i) * 2] > 0) {
      depth.asks.push({ price: rawDepth[(levels + i) * 2], qty: rawDepth[(levels + i) * 2 + 1] });
    }
  }
  // The bot's account sits at slot 1 of the accounts array.
  return Object.freeze({
    tick: st[0],
    bid: st[1],
    ask: st[2],
    mid: st[3],
    last: lastPx,
    cash: acct[4],
    position: acct[5],
    pnl: acct[7],
    orders,
    trades,
    depth,
  });
}

/// One tick of any bot against any sim. With latency, the bot is handed the
/// view from `lag.n` ticks ago while its orders still land on the book as it
/// is now, which is roughly what being slow feels like. Returns an error
/// message on an uncaught exception, null otherwise. Shared by the live
/// floor and the backtester so the two can never drift apart.
export function runBotTick(sim, fn, state, rawTrades, lastPx, lag) {
  const fresh = buildView(sim, rawTrades, lastPx);
  let view = fresh;
  if (lag.n > 0) {
    lag.buf.push(fresh);
    if (lag.buf.length > lag.n + 1) lag.buf.shift();
    if (lag.buf.length <= lag.n) return null; // still waiting for the wire
    view = lag.buf[0];
  }

  let actions = 0;
  const spend = () => {
    actions++;
    return actions <= ACTION_CAP;
  };
  const qtyOk = (q) => Number.isFinite(q) && Math.round(q) >= 1;
  const api = {
    limit: (side, px, qty) => {
      const p = Math.round(px);
      if (!spend() || !qtyOk(qty) || !Number.isFinite(p) || p < 1) return 0;
      return sim.bot_limit(side === 'buy', p, Math.min(Math.round(qty), QTY_CAP));
    },
    market: (side, qty) => {
      if (!spend() || !qtyOk(qty)) return 0;
      return sim.bot_market(side === 'buy', Math.min(Math.round(qty), QTY_CAP));
    },
    cancel: (id) => {
      if (!spend()) return false;
      return sim.bot_cancel(id);
    },
  };

  try {
    fn(view, api, state);
    return null;
  } catch (e) {
    return e.message || String(e);
  }
}

// ---- the backtester -------------------------------------------------------

const SEASON_TICKS = 100_000;
const CHUNK = 2_500;
const LADDER = [0, 2, 5, 10, 25];
const SWEEP = 8;

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

/// One headless season: a fresh market from `seed`, the bot (or nobody, when
/// fn is null) on the bot desk, run as fast as the engine goes but yielding
/// to the browser every chunk so the live market keeps animating.
async function simulate({ seed, fn, latency, conditions, onProgress }) {
  const bt = new PitSim(seed);
  bt.set_conditions(conditions.vol, conditions.informed);
  const state = {};
  const lag = { n: latency, buf: [] };
  const botEq = [];
  const waryEq = [];
  let lastPx = 0;
  let episodes = 0;
  let halts = 0;
  let wasEpisode = false;
  let wasHalted = false;
  let crash = null;
  let done = 0;

  while (done < SEASON_TICKS && !crash) {
    const end = Math.min(done + CHUNK, SEASON_TICKS);
    for (; done < end && !crash; done++) {
      bt.step(1);
      const t = bt.trades();
      if (t.length) lastPx = t[t.length - 5];
      if (fn) {
        const err = runBotTick(bt, fn, state, t, lastPx, lag);
        if (err) crash = { tick: done, message: err };
      }
      const st = bt.status();
      if (st[5] === 1 && !wasEpisode) episodes++;
      wasEpisode = st[5] === 1;
      if (st[7] === 1 && !wasHalted) halts++;
      wasHalted = st[7] === 1;
      if (done % 50 === 0) {
        const a = bt.accounts();
        botEq.push(a[7]);
        waryEq.push(a[23]);
      }
    }
    onProgress?.(done / SEASON_TICKS);
    await nextFrame();
  }
  const accounts = Array.from(bt.accounts());
  bt.free();
  return { seed, latency, accounts, botEq, waryEq, episodes, halts, crash };
}

function drawdown(series) {
  let peak = -Infinity;
  let worst = 0;
  for (const v of series) {
    peak = Math.max(peak, v);
    worst = Math.max(worst, peak - v);
  }
  return worst;
}

// Mean over standard deviation of the per-sample p&l changes, scaled to the
// season. Not a real Sharpe (no risk-free rate, sim time), hence the "-ish".
function sharpeIsh(series) {
  if (series.length < 3) return 0;
  const d = [];
  for (let i = 1; i < series.length; i++) d.push(series[i] - series[i - 1]);
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const variance = d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length;
  const sd = Math.sqrt(variance);
  return sd > 0 ? (mean / sd) * Math.sqrt(d.length) : 0;
}

export class Season {
  constructor(getSeed, getConditions, getLatency) {
    this.getSeed = getSeed;
    this.getConditions = getConditions;
    this.getLatency = getLatency;
    this.busy = false;
    $('bot-season').addEventListener('click', () => this.single());
    $('bot-ladder').addEventListener('click', () => this.ladder());
    $('bot-sweep').addEventListener('click', () => this.sweep());
  }

  compileOrExplain() {
    try {
      return compile($('bot-code').value);
    } catch (e) {
      $('bot-status').textContent = `won't compile: ${e.message}`;
      $('bot-status').className = 'err';
      return null;
    }
  }

  // Runs `work` with the busy flag held and the button showing progress.
  async guard(button, work) {
    if (this.busy) return;
    const fn = this.compileOrExplain();
    if (!fn) return;
    this.busy = true;
    const label = button.textContent;
    $('season-report').hidden = true;
    const started = performance.now();
    try {
      await work(fn, (text) => {
        button.textContent = text;
      });
    } finally {
      button.textContent = label;
      this.busy = false;
    }
    return (performance.now() - started) / 1000;
  }

  async single() {
    const button = $('bot-season');
    let withBot;
    let alone;
    const elapsed = await this.guard(button, async (fn, progress) => {
      const seed = this.getSeed();
      const conditions = this.getConditions();
      withBot = await simulate({
        seed,
        fn,
        latency: this.getLatency(),
        conditions,
        onProgress: (p) => progress(`simulating... ${Math.round(p * 50)}%`),
      });
      if (withBot.crash) return;
      alone = await simulate({
        seed,
        fn: null,
        latency: 0,
        conditions,
        onProgress: (p) => progress(`counterfactual... ${50 + Math.round(p * 50)}%`),
      });
    });
    if (!withBot) return;
    this.reportSingle(withBot, alone, elapsed);
  }

  async ladder() {
    const runs = [];
    const elapsed = await this.guard($('bot-ladder'), async (fn, progress) => {
      const seed = this.getSeed();
      const conditions = this.getConditions();
      for (let i = 0; i < LADDER.length; i++) {
        const r = await simulate({
          seed,
          fn,
          latency: LADDER[i],
          conditions,
          onProgress: (p) => progress(`lag ${LADDER[i]}... ${Math.round(((i + p) / LADDER.length) * 100)}%`),
        });
        runs.push(r);
        if (r.crash) break;
      }
    });
    if (runs.length) this.reportLadder(runs, elapsed);
  }

  async sweep() {
    const runs = [];
    const elapsed = await this.guard($('bot-sweep'), async (fn, progress) => {
      const base = this.getSeed();
      const conditions = this.getConditions();
      const latency = this.getLatency();
      for (let i = 0; i < SWEEP; i++) {
        const seed = (base + i * 7919) % 100_000_000 || 1;
        const r = await simulate({
          seed,
          fn,
          latency,
          conditions,
          onProgress: (p) => progress(`seed ${i + 1}/${SWEEP}... ${Math.round(((i + p) / SWEEP) * 100)}%`),
        });
        runs.push(r);
        if (r.crash) break;
      }
    });
    if (runs.length) this.reportSweep(runs, elapsed);
  }

  open() {
    const report = $('season-report');
    report.hidden = false;
    report.replaceChildren();
    return report;
  }

  crashed(report, r) {
    const p = document.createElement('p');
    p.className = 'err';
    p.textContent = `your bot crashed at tick ${r.crash.tick} on seed ${r.seed}: ${r.crash.message}. run abandoned.`;
    report.append(p);
  }

  reportSingle(r, alone, elapsed) {
    const report = this.open();
    if (r.crash) return this.crashed(report, r);

    const a = r.accounts;
    const lagNote = r.latency ? `, your bot ${r.latency} ticks behind` : '';
    report.append(
      para(
        `season on seed ${r.seed}: ${SEASON_TICKS.toLocaleString('en-US')} ticks in ` +
          `${elapsed.toFixed(1)}s (with a counterfactual run), ${r.episodes} informed ` +
          `episodes, ${r.halts} halts${lagNote}.`,
      ),
    );

    const desks = [
      ['your bot', 1],
      ['informed', 2],
      ['mm-fixed', 3],
      ['mm-skew', 4],
      ['mm-wary', 5],
      ['noise crowd', 6],
    ];
    const rows = desks.map(([name, i]) => {
      const vol = a[i * 4 + 2];
      const pnl = a[i * 4 + 3];
      return [name, vol.toLocaleString('en-US'), money(pnl), vol > 0 ? `${(pnl / vol).toFixed(2)}t` : '-', pnl];
    });
    report.append(table(['desk', 'volume', 'p&l', 'p&l per lot'], rows));

    const botFinal = a[7];
    const waryFinal = a[23];
    const waryAlone = alone.accounts[23];
    const delta = waryFinal - waryAlone;
    const verdict = para(
      botFinal > waryFinal
        ? `your bot beat mm-wary by ${money(botFinal - waryFinal)}.`
        : `mm-wary wins by ${money(waryFinal - botFinal)}. the floor remembers.`,
    );
    verdict.className = botFinal > waryFinal ? 'up' : '';
    const stats = para(
      `max drawdown ${money(drawdown(r.botEq))}, sharpe-ish ${sharpeIsh(r.botEq).toFixed(1)}. ` +
        `without you on the floor, mm-wary would have made ${money(waryAlone)}; your presence ` +
        `${delta >= 0 ? `added ${money(delta)} to that` : `took ${money(-delta)} from that`}.`,
    );
    const canvas = document.createElement('canvas');
    canvas.className = 'season-curve';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'equity curves: your bot in amber, mm-wary in green');
    report.append(canvas, verdict, stats);
    drawEquity(canvas, r.botEq, r.waryEq);
  }

  reportLadder(runs, elapsed) {
    const report = this.open();
    const last = runs[runs.length - 1];
    report.append(
      para(
        `latency ladder on seed ${runs[0].seed}: the same bot at ${LADDER.join(', ')} ticks ` +
          `of lag, ${runs.length} seasons in ${elapsed.toFixed(1)}s.`,
      ),
    );
    const rows = runs
      .filter((r) => !r.crash)
      .map((r) => {
        const bot = r.accounts[7];
        const wary = r.accounts[23];
        return [
          `${r.latency} ticks`,
          money(bot),
          money(bot - wary),
          money(drawdown(r.botEq)),
          sharpeIsh(r.botEq).toFixed(1),
          bot,
        ];
      });
    report.append(table(['latency', 'your p&l', 'vs mm-wary', 'drawdown', 'sharpe-ish'], rows));
    if (last.crash) this.crashed(report, last);
    if (rows.length >= 2) {
      const first = rows[0][5];
      const slow = rows[rows.length - 1][5];
      report.append(
        para(
          `from ${rows[0][0]} to ${rows[rows.length - 1][0]} of lag, your p&l moved by ` +
            `${money(slow - first)}. that difference is what speed is worth to this strategy.`,
        ),
      );
    }
  }

  reportSweep(runs, elapsed) {
    const report = this.open();
    const ok = runs.filter((r) => !r.crash);
    report.append(
      para(
        `seed sweep: the same bot across ${runs.length} seeds, ${elapsed.toFixed(1)}s total` +
          `${runs[0].latency ? `, ${runs[0].latency} ticks of lag` : ''}.`,
      ),
    );
    const rows = ok.map((r) => {
      const bot = r.accounts[7];
      const wary = r.accounts[23];
      return [String(r.seed), money(bot), money(wary), bot > wary ? 'you' : 'mm-wary', bot];
    });
    report.append(table(['seed', 'your p&l', 'mm-wary', 'winner'], rows));
    const crashed = runs.find((r) => r.crash);
    if (crashed) this.crashed(report, crashed);
    if (ok.length) {
      const pnls = ok.map((r) => r.accounts[7]);
      const wins = ok.filter((r) => r.accounts[7] > r.accounts[23]).length;
      const mean = pnls.reduce((x, y) => x + y, 0) / pnls.length;
      const summary = para(
        `you beat mm-wary in ${wins} of ${ok.length} seeds. mean ${money(mean)}, ` +
          `worst ${money(Math.min(...pnls))}, best ${money(Math.max(...pnls))}. ` +
          (wins === ok.length
            ? 'clean sweep. now try it with latency.'
            : wins === 0
              ? 'one seed can flatter anyone; eight do not.'
              : 'the spread between worst and best is the part to think about.'),
      );
      summary.className = wins > ok.length / 2 ? 'up' : '';
      report.append(summary);
    }
  }
}

function para(text) {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}

// Rows carry their cells as strings, plus a trailing number used to color
// the p&l cell (second column) up or down.
function table(headers, rows) {
  const t = document.createElement('table');
  t.className = 'desks';
  const tr = document.createElement('tr');
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    tr.append(th);
  }
  t.append(tr);
  for (const row of rows) {
    const r = document.createElement('tr');
    const cells = row.slice(0, headers.length);
    const pnl = row[row.length - 1];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      td.textContent = c;
      if (i === 2 && headers[2] === 'p&l') td.className = pnl > 50 ? 'up' : pnl < -50 ? 'down' : '';
      if (i === 1 && headers[1] === 'your p&l') td.className = pnl > 50 ? 'up' : pnl < -50 ? 'down' : '';
      r.append(td);
    });
    t.append(r);
  }
  return t;
}

function drawEquity(canvas, bot, wary) {
  const css = getComputedStyle(document.body);
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = 120;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  let lo = 0;
  let hi = 0;
  for (const s of [bot, wary]) {
    for (const v of s) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  if (hi - lo < 1) hi = lo + 1;
  const x = (i, n) => (i / (n - 1)) * w;
  const y = (v) => h - 4 - ((v - lo) / (hi - lo)) * (h - 8);
  ctx.strokeStyle = css.getPropertyValue('--panel-edge');
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, y(0));
  ctx.lineTo(w, y(0));
  ctx.stroke();
  ctx.setLineDash([]);
  const line = (series, color) => {
    if (series.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    series.forEach((v, i) => {
      if (i === 0) ctx.moveTo(x(i, series.length), y(v));
      else ctx.lineTo(x(i, series.length), y(v));
    });
    ctx.stroke();
  };
  line(wary, css.getPropertyValue('--green'));
  line(bot, css.getPropertyValue('--you'));
}
