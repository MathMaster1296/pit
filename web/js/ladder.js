import { price } from './fmt.js';

const ROWS = 17;
const HALF = Math.floor(ROWS / 2);

// The classic price ladder: bids on the left, asks on the right, prices down
// the middle, centered on the mid. Cells are built once and updated in
// place; rebuilding DOM at 60fps is how you get a warm laptop.
export class Ladder {
  constructor(el, onClick) {
    this.el = el;
    this.rows = [];
    for (let i = 0; i < ROWS; i++) {
      const bid = cell('bid');
      const px = cell('price');
      const ask = cell('ask');
      bid.addEventListener('click', () => {
        if (bid.dataset.px) onClick('buy', Number(bid.dataset.px));
      });
      ask.addEventListener('click', () => {
        if (ask.dataset.px) onClick('sell', Number(ask.dataset.px));
      });
      el.append(bid, px, ask);
      this.rows.push({ bid, px, ask });
    }
  }

  draw(depth, status, userOrders) {
    const levels = depth.length / 4;
    const bids = new Map();
    const asks = new Map();
    let maxQty = 1;
    for (let i = 0; i < levels; i++) {
      const [bp, bq] = [depth[i * 2], depth[i * 2 + 1]];
      const [ap, aq] = [depth[(levels + i) * 2], depth[(levels + i) * 2 + 1]];
      if (bp > 0) bids.set(bp, bq);
      if (ap > 0) asks.set(ap, aq);
      maxQty = Math.max(maxQty, bq, aq);
    }

    const mineBid = new Map(); // price -> my resting qty
    const mineAsk = new Map();
    for (let i = 0; i < userOrders.length; i += 4) {
      const mine = userOrders[i + 1] === 1 ? mineBid : mineAsk;
      const px = userOrders[i + 2];
      mine.set(px, (mine.get(px) || 0) + userOrders[i + 3]);
    }

    const [bb, ba, mid] = [status[1], status[2], status[3]];
    const center = Math.round(mid) || Math.round((bb + ba) / 2);

    for (let i = 0; i < ROWS; i++) {
      const p = center + HALF - i;
      const row = this.rows[i];
      row.px.firstChild.textContent = p > 0 ? price(p) : '';
      row.px.classList.toggle('touch', p === bb || p === ba);
      setSide(row.bid, bids.get(p), mineBid.get(p), maxQty, p);
      setSide(row.ask, asks.get(p), mineAsk.get(p), maxQty, p);
    }
  }
}

function cell(cls) {
  const div = document.createElement('div');
  div.className = `cell ${cls}`;
  if (cls === 'price') {
    div.append(document.createElement('span'));
    return div;
  }
  const bar = document.createElement('div');
  bar.className = 'bar';
  const mineTag = document.createElement('span');
  mineTag.className = 'mine';
  const qty = document.createElement('span');
  if (cls === 'ask') div.append(bar, qty, mineTag);
  else div.append(bar, mineTag, qty);
  return div;
}

function setSide(el, qty, mineQty, maxQty, px) {
  const pxStr = px > 0 ? String(px) : '';
  if (el.dataset.px !== pxStr) {
    el.dataset.px = pxStr;
    el.title = px > 0
      ? `rest a ${el.classList.contains('ask') ? 'sell' : 'buy'} limit at ${price(px)}`
      : '';
  }
  const [bar, a, b] = el.children;
  const qtySpan = el.classList.contains('ask') ? a : b;
  const mineSpan = el.classList.contains('ask') ? b : a;
  qtySpan.textContent = qty ? String(qty) : '';
  mineSpan.textContent = qty && mineQty ? `(${mineQty})` : '';
  bar.style.width = qty ? `${(100 * qty) / maxQty}%` : '0';
}
