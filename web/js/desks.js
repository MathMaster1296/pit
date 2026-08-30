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

export class Desks {
  constructor(table) {
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
      const badge = document.createElement('td');
      tr.append(name, pos, vol, pnl, badge);
      table.tBodies[0].append(tr);
      return { pos, vol, pnl, badge };
    });
  }

  draw(accounts, status) {
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
    }
    setBadge(this.rows[1].badge, informedActive ? 'active' : '', true);
    setBadge(this.rows[4].badge, waryIn ? '' : 'away', false);
  }
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
