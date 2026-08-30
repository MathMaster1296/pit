import init, { PitSim } from '../pkg/pit_wasm.js';
import { Ladder } from './ladder.js';
import { Chart } from './chart.js';
import { Tape } from './tape.js';
import { Desks } from './desks.js';
import { money, lots, price } from './fmt.js';

const $ = (id) => document.getElementById(id);

let sim = null;
let seed = 0;
let paused = false;
let tickCost = 0; // engine time per tick in microseconds, measured at warmup
let lastStatus = null;
let lastAccounts = null;
let lastTradePx = 0;
let wasEpisode = false;
let lastFillToast = 0;

// One-time tips, remembered across visits where the browser allows it.
const tips = (() => {
  try {
    return JSON.parse(localStorage.getItem('pit-tips')) || {};
  } catch {
    return {};
  }
})();

function tipOnce(key, text) {
  if (tips[key]) return;
  tips[key] = 1;
  try {
    localStorage.setItem('pit-tips', JSON.stringify(tips));
  } catch {
    // private windows forget, which just means the tip shows again
  }
  notify(text, 7000);
}

function notify(text, ttl = 3500) {
  const box = $('toasts');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = text;
  box.append(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, ttl);
  while (box.children.length > 3) box.firstChild.remove();
}

const chart = new Chart($('chart'));
const tape = new Tape($('tape'));
const desks = new Desks($('desks'));
const ladder = new Ladder($('ladder'), (side, px) => {
  if (!sim) return;
  placeLimit(side === 'buy', px);
});

function orderQty() {
  const q = Math.floor(Number($('qty').value));
  if (q >= 1 && q <= 500) return q;
  notify('qty needs to be between 1 and 500');
  return 0;
}

function placeLimit(buy, px) {
  const qty = orderQty();
  if (!qty || !px) return;
  const id = sim.user_limit(buy, px, qty);
  const orders = sim.user_orders();
  for (let i = 0; i < orders.length; i += 4) {
    if (orders[i] === id) {
      notify(`resting: ${buy ? 'buy' : 'sell'} ${orders[i + 3]} @ ${price(px)}`);
      break;
    }
  }
  render();
}

function restart(newSeed) {
  seed = newSeed;
  history.replaceState(null, '', `#${seed}`);
  $('seed').value = seed;
  sim = new PitSim(seed);
  chart.reset();
  tape.reset();
  desks.reset();
  lastTradePx = 0;
  // Run the market in before showing it, so the chart opens with history
  // instead of a lonely dot. The pre-open trades don't hit the tape. A batch
  // this long is also the one honest way to time the engine from JS, since
  // performance.now is too coarse to measure a frame's worth of ticks.
  const t0 = performance.now();
  sim.step(1500);
  tickCost = ((performance.now() - t0) * 1000) / 1500;
  chart.push(sim.series(), []);
  sim.trades();
  render();
}

function render() {
  const status = sim.status();
  const trades = sim.trades();
  const orders = sim.user_orders();
  const accounts = sim.accounts();
  lastStatus = status;
  lastAccounts = accounts;
  chart.push(sim.series(), trades);
  chart.draw();
  ladder.draw(sim.depth(16), status, orders);
  tape.push(trades);
  desks.draw(accounts, status);
  drawUser(accounts, orders);
  $('flatten').disabled = accounts[1] === 0;

  if (trades.length) lastTradePx = trades[trades.length - 5];
  const bb = status[1] ? price(status[1]) : '?';
  const ba = status[2] ? price(status[2]) : '?';
  $('quote-line').textContent =
    `${bb} / ${ba}` + (lastTradePx ? `, last ${price(lastTradePx)}` : '');

  const episode = status[5] === 1;
  $('episode-pill').hidden = !episode;
  if (episode && !wasEpisode) {
    tipOnce(
      'episode',
      'that shading is informed flow: someone can see where the price is headed. watch the desks table.',
    );
  }
  wasEpisode = episode;

  // Your fills, batched per frame so a burst reads as one line.
  let filled = 0;
  let notional = 0;
  for (let i = 0; i < trades.length; i += 6) {
    if (trades[i + 4] === 1 || trades[i + 5] === 1) {
      filled += trades[i + 2];
      notional += trades[i + 1] * trades[i + 2];
    }
  }
  if (filled > 0) {
    tipOnce('fill', 'p&l marks to the mid while you hold. flatten gets you out in one click.');
    const now = performance.now();
    if (now - lastFillToast > 1500) {
      lastFillToast = now;
      notify(`filled ${filled} @ ${price(notional / filled)}`);
    }
  }

  $('perf').textContent =
    `tick ${status[0]} | engine ${tickCost.toFixed(1)} us/tick in wasm | ` +
    `same seed, same market: #${seed}`;
}

function drawUser(accounts, orders) {
  const stats = $('user-stats');
  const pnl = accounts[3];
  stats.replaceChildren(
    stat('position', accounts[1] > 0 ? `+${accounts[1]}` : String(accounts[1])),
    stat('volume', lots(accounts[2])),
    stat('p&l', money(pnl), pnl > 50 ? 'up' : pnl < -50 ? 'down' : ''),
  );
  const list = $('orders');
  list.replaceChildren();
  for (let i = 0; i < orders.length; i += 4) {
    const id = orders[i];
    const row = document.createElement('div');
    row.className = 'order-row';
    const label = document.createElement('span');
    const buy = orders[i + 1] === 1;
    label.textContent = `${buy ? 'buy' : 'sell'} ${orders[i + 3]} @ ${price(orders[i + 2])}`;
    label.style.color = buy ? 'var(--green)' : 'var(--red)';
    const cancel = document.createElement('button');
    cancel.textContent = 'x';
    cancel.title = 'cancel';
    cancel.addEventListener('click', () => {
      sim.user_cancel(id);
      render();
    });
    row.append(label, cancel);
    list.append(row);
  }
}

function stat(k, v, cls = '') {
  const div = document.createElement('div');
  const key = document.createElement('span');
  key.className = 'k';
  key.textContent = k;
  const val = document.createElement('span');
  val.textContent = v;
  if (cls) val.className = cls;
  div.append(key, val);
  return div;
}

function frame() {
  if (sim && !paused) {
    sim.step(Number($('speed').value));
    render();
  }
  requestAnimationFrame(frame);
}

function wire() {
  $('restart').addEventListener('click', () => {
    const s = Math.floor(Number($('seed').value));
    restart(s >= 1 ? s : randomSeed());
  });
  $('pause').addEventListener('click', togglePause);
  $('buy').addEventListener('click', () => marketOrder(true));
  $('sell').addEventListener('click', () => marketOrder(false));
  $('join-bid').addEventListener('click', () => placeLimit(true, lastStatus?.[1]));
  $('join-ask').addEventListener('click', () => placeLimit(false, lastStatus?.[2]));
  $('flatten').addEventListener('click', () => {
    const pos = lastAccounts ? lastAccounts[1] : 0;
    if (pos === 0) return;
    sim.user_market(pos < 0, Math.abs(pos));
    render();
  });
  $('share').addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}#${seed}`;
    navigator.clipboard.writeText(url).then(
      () => notify('link copied. same seed, same market.'),
      () => notify(`copy this by hand: ${url}`),
    );
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      togglePause();
    }
  });
}

function marketOrder(buy) {
  const qty = orderQty();
  if (!qty) return;
  sim.user_market(buy, qty);
  render();
}

function togglePause() {
  paused = !paused;
  $('pause').textContent = paused ? 'resume' : 'pause';
}

function randomSeed() {
  return 1 + Math.floor(Math.random() * 999999);
}

init()
  .then(() => {
    $('loading').hidden = true;
    $('app').hidden = false;
    wire();
    const fromHash = Math.floor(Number(location.hash.slice(1)));
    restart(fromHash >= 1 ? fromHash : randomSeed());
    requestAnimationFrame(frame);
    if (!tips.welcome) {
      document.querySelector('details.about').open = true;
    }
    tipOnce(
      'welcome',
      'you have a desk: click a price in the book to rest an order there, or use the market buttons.',
    );
  })
  .catch((err) => {
    $('loading').textContent =
      'The engine failed to load. If you are running from a clone, build it first: ' +
      'wasm-pack build wasm --target web --release --out-dir ../web/pkg';
    console.error(err);
  });
