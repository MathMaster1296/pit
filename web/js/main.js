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

const chart = new Chart($('chart'));
const tape = new Tape($('tape'));
const desks = new Desks($('desks'));
const ladder = new Ladder($('ladder'), (side, px) => {
  if (!sim) return;
  const qty = orderQty();
  if (qty) sim.user_limit(side === 'buy', px, qty);
  render();
});

function orderQty() {
  const q = Math.floor(Number($('qty').value));
  return q >= 1 && q <= 500 ? q : 0;
}

function restart(newSeed) {
  seed = newSeed;
  history.replaceState(null, '', `#${seed}`);
  $('seed').value = seed;
  sim = new PitSim(seed);
  chart.reset();
  tape.reset();
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
  chart.push(sim.series(), trades);
  chart.draw();
  ladder.draw(sim.depth(16), status, orders);
  tape.push(trades);
  desks.draw(accounts, status);
  drawUser(accounts, orders);
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
  $('buy').addEventListener('click', () => {
    if (orderQty()) sim.user_market(true, orderQty());
    render();
  });
  $('sell').addEventListener('click', () => {
    if (orderQty()) sim.user_market(false, orderQty());
    render();
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      togglePause();
    }
  });
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
  })
  .catch((err) => {
    $('loading').textContent =
      'The engine failed to load. If you are running from a clone, build it first: ' +
      'wasm-pack build wasm --target web --release --out-dir ../web/pkg';
    console.error(err);
  });
