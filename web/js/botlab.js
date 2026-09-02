// The bot lab: visitors write a strategy in the page, and it trades on the
// same book as everyone else through its own desk. The code runs with
// new Function, which is fine here: it is the visitor's own browser, and the
// worst they can do is lose pretend money faster.

const $ = (id) => document.getElementById(id);

const ACTION_CAP = 6; // per tick; a bot that needs more is a bug, not a desk
const QTY_CAP = 200;

export const PRESETS = {
  template: `// your bot runs once per simulation tick.
//
// view: { tick, bid, ask, mid, last, position, cash, pnl,
//         orders: [{id, side, price, qty}],   your open orders
//         trades: [{price, qty, side}] }      prints from this tick
// api:  { limit(side, price, qty), market(side, qty), cancel(id) }
//       side is 'buy' or 'sell', prices are integer ticks (cents)
// state: an object that survives between ticks, yours to use
//
// caps: ${ACTION_CAP} actions per tick, ${QTY_CAP} lots per order.
// an exception fires the bot, so trade carefully.

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
    const sim = this.getSim();
    const st = sim.status();
    const acct = sim.accounts();
    const rawOrders = sim.bot_orders();

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
    });

    let actions = 0;
    const spend = () => {
      actions++;
      return actions <= ACTION_CAP;
    };
    const qtyOk = (q) => Number.isFinite(q) && Math.round(q) >= 1;
    const api = {
      limit: (side, price, qty) => {
        const p = Math.round(price);
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
      this.fn(view, api, this.state);
    } catch (e) {
      this.fire();
      this.status(`crashed and got fired: ${e.message}`, 'err');
      this.notify('your bot threw an exception and was escorted out');
    }
  }
}
