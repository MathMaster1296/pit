import { price } from './fmt.js';

const KEEP = 30;

export class Tape {
  constructor(el) {
    this.el = el;
  }

  reset() {
    this.el.replaceChildren();
  }

  push(trades) {
    // Newest at the top. Trades arrive oldest first, so walk backwards.
    for (let i = trades.length - 6; i >= 0; i -= 6) {
      const buy = trades[i + 3] === 1;
      const you = trades[i + 4] === 1 || trades[i + 5] === 1;
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = `${trades[i + 2]} @ ${price(trades[i + 1])}`;
      left.style.color = buy ? 'var(--green)' : 'var(--red)';
      li.append(left);
      if (you) {
        const tag = document.createElement('span');
        tag.className = 'you-tag';
        tag.textContent = 'you';
        li.append(tag);
      }
      this.el.prepend(li);
    }
    while (this.el.children.length > KEEP) this.el.lastChild.remove();
  }
}
