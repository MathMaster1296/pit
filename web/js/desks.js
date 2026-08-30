import { money, lots } from './fmt.js';

// Order matches the accounts() array from the wasm side.
const DESKS = [
  { name: 'you', cls: 'you-row', tip: 'your desk. cash plus position, marked to the mid.' },
  { name: 'informed', tip: 'shows up during the shaded episodes and can see where fair value is headed' },
  { name: 'mm-fixed', tip: 'quotes a constant spread around the mid, no matter what is happening' },
  { name: 'mm-skew', tip: 'shifts its quotes against its inventory so a position never builds up' },
  { name: 'mm-wary', tip: 'skews like mm-skew, widens when flow turns one-sided, and walks away past a threshold' },
  { name: 'noise crowd', tip: 'twenty mostly-random traders, shown as one book. they pay for everything.' },
];

const SPARK_W = 56;
const SPARK_H = 16;
const SPARK_LEN = 300; // points kept, sampled every 6th frame

export class Desks {
  constructor(table) {
    this.frame = 0;
    this.rows = DESKS.map((d) => {
      const tr = document.createElement('tr');
      if (d.cls) tr.className = d.cls;
      const name = document.createElement('td');
      name.textContent = d.name;
      name.title = d.tip;
      const pos = document.createElement('td');
      pos.className = 'pos';
      const vol = document.createElement('td');
      vol.className = 'pos';
      const pnl = document.createElement('td');
      const spark = document.createElement('td');
      spark.className = 'spark';
      spark.title = 'recent p&l';
      const canvas = document.createElement('canvas');
      spark.append(canvas);
      const badge = document.createElement('td');
      tr.append(name, pos, vol, pnl, spark, badge);
      table.tBodies[0].append(tr);
      return { pos, vol, pnl, badge, canvas, ctx: canvas.getContext('2d'), hist: [] };
    });
  }

  reset() {
    for (const row of this.rows) row.hist.length = 0;
  }

  draw(accounts, status) {
    this.frame++;
    const sample = this.frame % 6 === 0;
    const informedActive = status[5] === 1;
    const waryIn = status[6] === 1;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const inv = accounts[i * 4 + 1];
      const pnl = accounts[i * 4 + 3];
      row.pos.textContent = inv > 0 ? `+${inv}` : String(inv);
      row.vol.textContent = lots(accounts[i * 4 + 2]);
      row.pnl.textContent = money(pnl);
      row.pnl.className = pnl > 50 ? 'up' : pnl < -50 ? 'down' : '';
      if (sample) {
        row.hist.push(pnl);
        if (row.hist.length > SPARK_LEN) row.hist.shift();
        drawSpark(row);
      }
    }
    setBadge(this.rows[1].badge, informedActive ? 'active' : '', true);
    setBadge(this.rows[4].badge, waryIn ? '' : 'away', false);
  }
}

let sparkColor = null;

// Each sparkline scales to its own window, so it shows the shape of the
// p&l, not its size. The pnl column next door has the size.
function drawSpark(row) {
  const dpr = window.devicePixelRatio || 1;
  const c = row.canvas;
  if (c.width !== SPARK_W * dpr) {
    c.width = SPARK_W * dpr;
    c.height = SPARK_H * dpr;
    c.style.width = `${SPARK_W}px`;
    c.style.height = `${SPARK_H}px`;
  }
  const ctx = row.ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, SPARK_W, SPARK_H);
  const hist = row.hist;
  if (hist.length < 2) return;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of hist) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (hi - lo < 1) {
    lo -= 1;
    hi += 1;
  }
  if (!sparkColor) {
    sparkColor = getComputedStyle(document.body).getPropertyValue('--muted');
  }
  ctx.strokeStyle = sparkColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < hist.length; i++) {
    const x = (i / (hist.length - 1)) * SPARK_W;
    const y = SPARK_H - 1 - ((hist[i] - lo) / (hi - lo)) * (SPARK_H - 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function setBadge(td, text, hot) {
  if (!text) {
    td.replaceChildren();
    return;
  }
  if (!td.firstChild) {
    const span = document.createElement('span');
    span.className = hot ? 'badge hot' : 'badge';
    td.append(span);
  }
  td.firstChild.textContent = text;
}
