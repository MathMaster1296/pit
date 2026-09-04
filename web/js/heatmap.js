// The book heatmap, the view every HFT screenshot has: time runs left to
// right, price runs top to bottom, and each resting level glows brighter the
// more size sits on it. Bids in the bid color, asks in the ask color, the
// mid as a bright thread through the middle, trades as dots on top.
const COLS = 240;
const LEVELS = 16;
const PAD = 12; // ticks of headroom above and below the mid's range

export class Heatmap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cols = [];
    this.refreshColors();
  }

  refreshColors() {
    const css = getComputedStyle(document.body);
    this.bid = rgb(css.getPropertyValue('--green'));
    this.ask = rgb(css.getPropertyValue('--red'));
    this.mid = css.getPropertyValue('--text');
    this.you = css.getPropertyValue('--you');
    this.muted = css.getPropertyValue('--muted');
  }

  reset() {
    this.cols.length = 0;
  }

  /// One column per animation frame, whatever the speed. At 32x each column
  /// covers 32 ticks, which just makes the picture zoom out.
  push(depth, status, trades) {
    const col = { mid: status[3], bids: [], asks: [], trades: [] };
    for (let i = 0; i < LEVELS; i++) {
      const bp = depth[i * 2];
      const ap = depth[(LEVELS + i) * 2];
      if (bp > 0) col.bids.push([bp, depth[i * 2 + 1]]);
      if (ap > 0) col.asks.push([ap, depth[(LEVELS + i) * 2 + 1]]);
    }
    for (let i = 0; i < trades.length; i += 6) {
      col.trades.push([trades[i + 1], trades[i + 4] === 1 || trades[i + 5] === 1]);
    }
    this.cols.push(col);
    if (this.cols.length > COLS) this.cols.shift();
  }

  draw() {
    const { canvas, ctx, cols } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (cols.length < 2) return;

    let lo = Infinity;
    let hi = -Infinity;
    let maxQty = 1;
    for (const c of cols) {
      lo = Math.min(lo, c.mid);
      hi = Math.max(hi, c.mid);
      for (const [, q] of c.bids) maxQty = Math.max(maxQty, q);
      for (const [, q] of c.asks) maxQty = Math.max(maxQty, q);
    }
    lo -= PAD;
    hi += PAD;
    const colW = w / COLS;
    const rowH = h / (hi - lo);
    const x = (i) => (i + COLS - cols.length) * colW;
    const y = (p) => h - (p - lo) * rowH;

    // Heat scales with the square root of size so thin levels still show.
    const paint = (i, levels, color) => {
      for (const [p, q] of levels) {
        if (p < lo || p > hi) continue;
        const a = Math.min(1, Math.sqrt(q / maxQty)) * 0.85;
        ctx.fillStyle = `rgba(${color},${a.toFixed(3)})`;
        ctx.fillRect(x(i), y(p) - rowH / 2, colW + 0.6, Math.max(rowH, 1));
      }
    };
    for (let i = 0; i < cols.length; i++) {
      paint(i, cols[i].bids, this.bid);
      paint(i, cols[i].asks, this.ask);
    }

    ctx.strokeStyle = this.mid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    cols.forEach((c, i) => {
      const px = x(i) + colW / 2;
      if (i === 0) ctx.moveTo(px, y(c.mid));
      else ctx.lineTo(px, y(c.mid));
    });
    ctx.stroke();

    for (let i = 0; i < cols.length; i++) {
      for (const [p, you] of cols[i].trades) {
        ctx.fillStyle = you ? this.you : this.muted;
        const s = you ? 4 : 2;
        ctx.fillRect(x(i) + colW / 2 - s / 2, y(p) - s / 2, s, s);
      }
    }

    ctx.fillStyle = this.muted;
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText((hi / 100).toFixed(2), 4, 11);
    ctx.fillText((lo / 100).toFixed(2), 4, h - 4);
  }
}

// "#4caf7d" or " #4caf7d" to "76,175,125" for building rgba() strings.
function rgb(hex) {
  const c = hex.trim().replace('#', '');
  const n = parseInt(c.length === 3 ? c.split('').map((ch) => ch + ch).join('') : c, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
