// The depth chart: cumulative resting quantity on each side of the book,
// the liquidity mountain every trading screen has. Green wall of bids on
// the left, red wall of asks on the right, and the valley between them is
// the spread.
export class Depth {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.refreshColors();
  }

  refreshColors() {
    const css = getComputedStyle(document.body);
    this.green = css.getPropertyValue('--green');
    this.red = css.getPropertyValue('--red');
    this.muted = css.getPropertyValue('--muted');
  }

  draw(depth, status) {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const levels = depth.length / 4;
    const bids = [];
    const asks = [];
    let cum = 0;
    for (let i = 0; i < levels; i++) {
      const [p, q] = [depth[i * 2], depth[i * 2 + 1]];
      if (p > 0) bids.push({ p, cum: (cum += q) });
    }
    cum = 0;
    for (let i = 0; i < levels; i++) {
      const [p, q] = [depth[(levels + i) * 2], depth[(levels + i) * 2 + 1]];
      if (p > 0) asks.push({ p, cum: (cum += q) });
    }
    if (!bids.length || !asks.length) return;

    const lo = bids[bids.length - 1].p;
    const hi = asks[asks.length - 1].p;
    const maxCum = Math.max(bids[bids.length - 1].cum, asks[asks.length - 1].cum);
    const x = (p) => ((p - lo) / (hi - lo || 1)) * w;
    const y = (c) => h - (c / maxCum) * (h - 6);

    // Each side is a staircase from its touch outward.
    const side = (rows, color, dir) => {
      ctx.beginPath();
      ctx.moveTo(x(rows[0].p), h);
      let prevY = y(0);
      for (const r of rows) {
        ctx.lineTo(x(r.p), prevY);
        prevY = y(r.cum);
        ctx.lineTo(x(r.p), prevY);
      }
      const edge = dir < 0 ? 0 : w;
      ctx.lineTo(edge, prevY);
      ctx.stroke();
      ctx.lineTo(edge, h);
      ctx.closePath();
      ctx.globalAlpha = 0.18;
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = ctx.fillStyle = this.green;
    side(bids, this.green, -1);
    ctx.strokeStyle = ctx.fillStyle = this.red;
    side(asks, this.red, 1);

    // A tick for the mid, so the valley has a landmark.
    const mid = status[3];
    if (mid > lo && mid < hi) {
      ctx.strokeStyle = this.muted;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x(mid), h);
      ctx.lineTo(x(mid), 4);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}
