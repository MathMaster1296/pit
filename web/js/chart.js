import { price } from './fmt.js';

const WINDOW = 2600; // ticks of history on screen

// Rolling price chart on a canvas: mid, fair value, trade prints, and a wash
// of color over the stretches where the informed trader is active.
export class Chart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.samples = [];
    this.trades = [];
    const css = getComputedStyle(document.body);
    this.color = {
      mid: css.getPropertyValue('--text'),
      fair: css.getPropertyValue('--fair'),
      episode: css.getPropertyValue('--episode'),
      buy: css.getPropertyValue('--green'),
      sell: css.getPropertyValue('--red'),
      you: css.getPropertyValue('--you'),
      grid: css.getPropertyValue('--panel-edge'),
      muted: css.getPropertyValue('--muted'),
    };
  }

  reset() {
    this.samples.length = 0;
    this.trades.length = 0;
  }

  push(series, trades) {
    for (let i = 0; i < series.length; i += 4) {
      this.samples.push({
        tick: series[i],
        mid: series[i + 1],
        fair: series[i + 2],
        ep: series[i + 3] === 1,
      });
    }
    for (let i = 0; i < trades.length; i += 6) {
      this.trades.push({
        tick: trades[i],
        px: trades[i + 1],
        buy: trades[i + 3] === 1,
        you: trades[i + 4] === 1 || trades[i + 5] === 1,
      });
    }
    if (this.samples.length > WINDOW) this.samples.splice(0, this.samples.length - WINDOW);
    const oldest = this.samples.length ? this.samples[0].tick : 0;
    while (this.trades.length && this.trades[0].tick < oldest) this.trades.shift();
  }

  draw() {
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
    if (this.samples.length < 2) return;

    const t0 = this.samples[0].tick;
    const t1 = this.samples[this.samples.length - 1].tick;
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of this.samples) {
      lo = Math.min(lo, s.mid, s.fair);
      hi = Math.max(hi, s.mid, s.fair);
    }
    const pad = Math.max(3, (hi - lo) * 0.08);
    lo -= pad;
    hi += pad;
    const x = (t) => ((t - t0) / (t1 - t0)) * w;
    const y = (p) => h - ((p - lo) / (hi - lo)) * h;

    // Episode shading first, underneath everything.
    ctx.fillStyle = this.color.episode;
    let start = null;
    for (const s of this.samples) {
      if (s.ep && start === null) start = s.tick;
      if (!s.ep && start !== null) {
        ctx.fillRect(x(start), 0, x(s.tick) - x(start), h);
        start = null;
      }
    }
    if (start !== null) ctx.fillRect(x(start), 0, x(t1) - x(start), h);

    // A few horizontal gridlines with price labels.
    ctx.strokeStyle = this.color.grid;
    ctx.fillStyle = this.color.muted;
    ctx.font = '10px ui-monospace, monospace';
    ctx.lineWidth = 1;
    const step = niceStep(hi - lo);
    for (let p = Math.ceil(lo / step) * step; p < hi; p += step) {
      ctx.beginPath();
      ctx.moveTo(0, y(p));
      ctx.lineTo(w, y(p));
      ctx.stroke();
      ctx.fillText(price(p), 4, Math.max(y(p) - 3, 10));
    }

    line(ctx, this.samples, x, y, (s) => s.fair, this.color.fair, [4, 4]);
    line(ctx, this.samples, x, y, (s) => s.mid, this.color.mid, []);

    for (const t of this.trades) {
      if (t.you) {
        ctx.fillStyle = this.color.you;
        ctx.fillRect(x(t.tick) - 2.5, y(t.px) - 2.5, 5, 5);
      } else {
        ctx.fillStyle = t.buy ? this.color.buy : this.color.sell;
        ctx.fillRect(x(t.tick) - 1, y(t.px) - 1, 2, 2);
      }
    }
  }
}

function line(ctx, samples, x, y, get, color, dash) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x(samples[0].tick), y(get(samples[0])));
  for (const s of samples) ctx.lineTo(x(s.tick), y(get(s)));
  ctx.stroke();
  ctx.setLineDash([]);
}

// Pick a gridline spacing that lands on round prices: 10 ticks, 25, 50...
function niceStep(range) {
  const options = [5, 10, 25, 50, 100, 250, 500, 1000];
  for (const s of options) if (range / s <= 6) return s;
  return 2000;
}
