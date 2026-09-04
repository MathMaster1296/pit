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
// rejected (they return 0). "run a season" backtests this exact code.

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
// and flatten when it goes quiet. this is a taker, not a maker.
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

export class BotLab {
  constructor(getSim, notify) {
    this.getSim = getSim;
    this.notify = notify;
    this.fn = null;
    this.state = {};
    this.running = false;

    let saved = null;
    try {
      saved = localStorage.getItem('pit-bot-code');
    } catch {
      // no storage, no saved bot
    }
    $('bot-code').value = saved || PRESETS.template;

    $('bot-preset').addEventListener('change', () => {
      const p = PRESETS[$('bot-preset').value];
      if (p) {
        $('bot-code').value = p;
        this.status('preset loaded, hit hire when ready');
      }
    });
    $('bot-run').addEventListener('click', () => {
      if (this.running) this.fire('fired. the desk is dark.');
      else this.hire();
    });
  }

  status(text, cls = '') {
    const el = $('bot-status');
    el.textContent = text;
    el.className = cls;
  }

  hire() {
    const code = $('bot-code').value;
    try {
      this.fn = new Function('view', 'api', 'state', `"use strict";\n${code}`);
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
    this.running = true;
    $('bot-run').textContent = 'fire bot';
    this.status('on the floor', 'ok');
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
  }

  /// Called once per simulation tick with that tick's raw trade array.
  tick(rawTrades, lastPx) {
    if (!this.running || !this.fn) return;
    const err = runBotTick(this.getSim(), this.fn, this.state, rawTrades, lastPx);
    if (err) {
      this.fire();
      this.status(`crashed and got fired: ${err}`, 'err');
      this.notify('your bot threw an exception and was escorted out');
    }
  }
}

/// One tick of any bot against any sim. Returns an error message on an
/// uncaught exception, null otherwise. Shared by the live floor and the
/// season backtester so the two can never drift apart.
export function runBotTick(sim, fn, state, rawTrades, lastPx) {
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
  const view = Object.freeze({
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

const SEASON_TICKS = 100_000;
const CHUNK = 2_000;

// The season backtester: a fresh copy of the market from the same seed, run
// headless as fast as the engine goes, with the editor's current code on the
// bot desk. Same engine, same tuning, no rendering, and a report at the end.
export class Season {
  constructor(getSeed) {
    this.getSeed = getSeed;
    this.busy = false;
    $('bot-season').addEventListener('click', () => this.run());
  }

  run() {
    if (this.busy) return;
    let fn;
    try {
      fn = new Function('view', 'api', 'state', `"use strict";\n${$('bot-code').value}`);
    } catch (e) {
      $('bot-status').textContent = `won't compile: ${e.message}`;
      $('bot-status').className = 'err';
      return;
    }
    this.busy = true;
    const button = $('bot-season');
    const report = $('season-report');
    report.hidden = true;

    const seed = this.getSeed();
    const bt = new PitSim(seed);
    const state = {};
    const started = performance.now();
    const botEquity = [];
    const waryEquity = [];
    let lastPx = 0;
    let done = 0;
    let episodes = 0;
    let halts = 0;
    let wasEpisode = false;
    let wasHalted = false;
    let crash = null;

    const finish = () => {
      const elapsed = (performance.now() - started) / 1000;
      this.busy = false;
      button.textContent = 'run a season';
      this.report(bt, seed, elapsed, botEquity, waryEquity, episodes, halts, crash);
      bt.free();
    };

    const chunk = () => {
      for (let i = 0; i < CHUNK && done < SEASON_TICKS && !crash; i++, done++) {
        bt.step(1);
        const t = bt.trades();
        if (t.length) lastPx = t[t.length - 5];
        const err = runBotTick(bt, fn, state, t, lastPx);
        if (err) crash = { tick: done, message: err };
        const st = bt.status();
        if (st[5] === 1 && !wasEpisode) episodes++;
        wasEpisode = st[5] === 1;
        if (st[7] === 1 && !wasHalted) halts++;
        wasHalted = st[7] === 1;
        if (done % 50 === 0) {
          const a = bt.accounts();
          botEquity.push(a[7]);
          waryEquity.push(a[23]);
        }
      }
      if (done < SEASON_TICKS && !crash) {
        button.textContent = `simulating... ${Math.round((100 * done) / SEASON_TICKS)}%`;
        requestAnimationFrame(chunk);
      } else {
        finish();
      }
    };
    button.textContent = 'simulating... 0%';
    requestAnimationFrame(chunk);
  }

  report(bt, seed, elapsed, botEquity, waryEquity, episodes, halts, crash) {
    const report = $('season-report');
    report.hidden = false;
    report.replaceChildren();

    if (crash) {
      const p = document.createElement('p');
      p.className = 'err';
      p.textContent = `your bot crashed at tick ${crash.tick}: ${crash.message}. season abandoned.`;
      report.append(p);
      return;
    }

    const a = bt.accounts();
    const desks = [
      ['your bot', 1],
      ['informed', 2],
      ['mm-fixed', 3],
      ['mm-skew', 4],
      ['mm-wary', 5],
      ['noise crowd', 6],
    ];
    const head = document.createElement('p');
    head.textContent =
      `season on seed ${seed}: ${SEASON_TICKS.toLocaleString('en-US')} ticks in ` +
      `${elapsed.toFixed(1)}s, ${episodes} informed episodes, ${halts} halts.`;
    report.append(head);

    const table = document.createElement('table');
    table.className = 'desks';
    const tr = document.createElement('tr');
    for (const h of ['desk', 'volume', 'p&l', 'p&l per lot']) {
      const th = document.createElement('th');
      th.textContent = h;
      tr.append(th);
    }
    table.append(tr);
    for (const [name, i] of desks) {
      const row = document.createElement('tr');
      const vol = a[i * 4 + 2];
      const pnl = a[i * 4 + 3];
      const cells = [
        name,
        vol.toLocaleString('en-US'),
        money(pnl),
        vol > 0 ? `${((pnl / vol) * 1).toFixed(2)}t` : '-',
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        row.append(td);
      }
      const pnlCell = row.children[2];
      pnlCell.className = pnl > 50 ? 'up' : pnl < -50 ? 'down' : '';
      table.append(row);
    }
    report.append(table);

    // The race: your equity against mm-wary's, plus the worst stretch.
    let peak = -Infinity;
    let drawdown = 0;
    for (const v of botEquity) {
      peak = Math.max(peak, v);
      drawdown = Math.max(drawdown, peak - v);
    }
    const botFinal = a[7];
    const waryFinal = a[23];
    const verdict = document.createElement('p');
    if (botFinal > waryFinal) {
      verdict.textContent =
        `your bot beat mm-wary by ${money(botFinal - waryFinal)}. ` +
        `max drawdown along the way: ${money(drawdown)}.`;
      verdict.className = 'up';
    } else {
      verdict.textContent =
        `mm-wary wins by ${money(waryFinal - botFinal)}. ` +
        `your max drawdown was ${money(drawdown)}. the floor remembers.`;
    }

    const canvas = document.createElement('canvas');
    canvas.className = 'season-curve';
    report.append(canvas, verdict);
    drawEquity(canvas, botEquity, waryEquity);
  }
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
