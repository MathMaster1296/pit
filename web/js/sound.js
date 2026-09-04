// Synthesized floor noise: tape clicks pitched by aggressor side, an alert
// when informed flow arrives, a low gong for the circuit breaker. No audio
// files, just oscillators. Off by default because autoplaying finance sounds
// at people is a crime.
export class SoundFx {
  constructor() {
    this.on = false;
    this.ctx = null;
    this.lastBlip = 0;
  }

  toggle() {
    this.on = !this.on;
    if (this.on && !this.ctx) {
      // Created inside the click handler, so the browser allows it.
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    return this.on;
  }

  tone(freq, dur, type, gain, delay = 0) {
    if (!this.on || !this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const amp = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(gain, t0);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  trade(buy) {
    const now = performance.now();
    if (now - this.lastBlip < 80) return;
    this.lastBlip = now;
    this.tone(buy ? 760 : 520, 0.04, 'square', 0.015);
  }

  episode() {
    this.tone(880, 0.1, 'sine', 0.04);
    this.tone(660, 0.14, 'sine', 0.04, 0.12);
  }

  halt() {
    this.tone(160, 0.6, 'sawtooth', 0.05);
    this.tone(110, 0.8, 'sine', 0.05, 0.05);
  }

  reopen() {
    this.tone(440, 0.08, 'sine', 0.04);
    this.tone(660, 0.12, 'sine', 0.04, 0.09);
  }
}
