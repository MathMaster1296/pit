// One tick is a cent. Everything the sim hands us is in ticks and lots.

export function price(ticks) {
  return (ticks / 100).toFixed(2);
}

export function money(ticks) {
  const d = ticks / 100;
  const abs = Math.abs(d);
  const s = abs >= 1000 ? Math.round(abs).toLocaleString('en-US') : abs.toFixed(2);
  return (d < 0 ? '-$' : '$') + s;
}

export function lots(n) {
  return n >= 10000 ? (n / 1000).toFixed(0) + 'k' : String(n);
}
