import init, { PitSim } from '../pkg/pit_wasm.js';
import { Ladder } from './ladder.js';
import { Chart } from './chart.js';
import { Tape } from './tape.js';
import { Desks } from './desks.js';
import { Depth } from './depth.js';
import { BotLab, Season } from './botlab.js';
import { SoundFx } from './sound.js';
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
let wasHalted = false;
let lastFillToast = 0;
let lastHeadline = 0;

// What the wire says when informed flow shows up. Deliberately cryptic: the
// desks that matter already know, and you are not one of the desks that
// matter.
const HEADLINES = [
  'unusual size on the tape',
  'someone is in a hurry',
  'the phones upstairs are ringing',
  'big footprints in the book',
  'a desk is leaning hard on one side',
  'flow has an opinion',
  'somebody read tomorrow\'s paper',
  'the crowd is one step behind again',
];

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
const depthChart = new Depth($('depth'));
const botLab = new BotLab(() => sim, notify);
const season = new Season(() => seed);
const sound = new SoundFx();
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
  if (marketClosed()) return;
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
  botLab.onRestart();
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

function render(pending) {
  const status = sim.status();
  const trades = pending ?? Array.from(sim.trades());
  const orders = sim.user_orders();
  const accounts = sim.accounts();
  const depth = sim.depth(16);
  lastStatus = status;
  lastAccounts = accounts;
  chart.push(sim.series(), trades);
  chart.draw();
  ladder.draw(depth, status, orders);
  depthChart.draw(depth, status);
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
    sound.episode();
    const now = performance.now();
    if (now - lastHeadline > 12000 && Number($('speed').value) <= 8) {
      lastHeadline = now;
      notify(`wire: ${HEADLINES[Math.floor(status[0] / 977) % HEADLINES.length]}`);
    }
  }
  wasEpisode = episode;

  const halted = status[7] === 1;
  $('halt-pill').hidden = !halted;
  if (halted && !wasHalted) {
    notify('trading halted: that move tripped the circuit breaker. all resting orders purged.');
    sound.halt();
  }
  if (!halted && wasHalted) {
    notify('reopened. mind the gap.');
    sound.reopen();
  }
  wasHalted = halted;

  for (let i = 0; i < trades.length; i += 6) {
    sound.trade(trades[i + 3] === 1);
  }

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
    cancel.setAttribute('aria-label', `cancel ${label.textContent}`);
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
    // Tick one at a time so the scripted bot gets a turn every tick, the
    // same cadence the Rust desks get.
    const speed = Number($('speed').value);
    const pending = [];
    for (let i = 0; i < speed; i++) {
      sim.step(1);
      const t = sim.trades();
      if (t.length) lastTradePx = t[t.length - 5];
      for (const v of t) pending.push(v);
      botLab.tick(t, lastTradePx);
    }
    render(pending);
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
    if (marketClosed()) return;
    const pos = lastAccounts ? lastAccounts[1] : 0;
    if (pos === 0) return;
    sim.user_market(pos < 0, Math.abs(pos));
    render();
  });
  $('today').addEventListener('click', () => {
    const d = new Date();
    const daily =
      d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    restart(daily);
    notify('today\'s market: everyone in the world gets this exact seed today.');
  });
  $('sound').addEventListener('click', () => {
    $('sound').textContent = sound.toggle() ? 'sound: on' : 'sound: off';
  });
  $('share').addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}#${seed}`;
    navigator.clipboard.writeText(url).then(
      () => notify('link copied. same seed, same market.'),
      () => notify(`copy this by hand: ${url}`),
    );
  });
  document.addEventListener('keydown', (e) => {
    // Space pauses, unless focus is on something that uses space itself.
    const busy =
      e.target instanceof Element &&
      e.target.closest('input, textarea, select, button, [role="button"], summary');
    if (e.code === 'Space' && !busy) {
      e.preventDefault();
      togglePause();
    }
  });

  $('theme').addEventListener('click', () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    remember('pit-theme', root.dataset.theme);
    applyPrefs();
  });
  $('palette').addEventListener('click', () => {
    const root = document.documentElement;
    if (root.dataset.palette === 'cb') delete root.dataset.palette;
    else root.dataset.palette = 'cb';
    remember('pit-palette', root.dataset.palette || '');
    applyPrefs();
  });
}

function remember(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // no storage means the preference lasts for this visit only
  }
}

// Sync the preference buttons and every canvas that caches palette colors.
function applyPrefs() {
  const root = document.documentElement;
  $('theme').textContent = `theme: ${root.dataset.theme === 'light' ? 'light' : 'dark'}`;
  $('palette').textContent =
    `colors: ${root.dataset.palette === 'cb' ? 'blue/orange' : 'green/red'}`;
  chart.refreshColors();
  depthChart.refreshColors();
  if (sim) render();
}

function marketOrder(buy) {
  if (marketClosed()) return;
  const qty = orderQty();
  if (!qty) return;
  sim.user_market(buy, qty);
  render();
}

function marketClosed() {
  if (lastStatus && lastStatus[7] === 1) {
    notify('the market is halted. nobody trades, not even you.');
    return true;
  }
  return false;
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
    applyPrefs();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      $('speed').value = '1';
    }
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
