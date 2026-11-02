// =====================================================================
// 効果音（WebAudio で合成。音声ファイルなし）
//   鉄砲・爆発・旗を守りきったファンファーレ・警告。1秒あたりの数を制限して、うるさくならないように
// =====================================================================
const Sfx = {
  ctx: null, on: true, budget: 0, last: 0,
  init() {
    try { this.on = localStorage.getItem('jinchi47_sound') !== 'off'; } catch (e) { /* 使えない環境 */ }
    const start = () => {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); this.master = this.ctx.createGain(); this.master.gain.value = 0.5; this.master.connect(this.ctx.destination); this.noise = this.makeNoise(); } catch (e) { this.ctx = null; }
    };
    // ブラウザは、画面に触れたあとでないと音を出せない
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, start, { once: false, passive: true });
  },
  toggle() {
    this.on = !this.on;
    try { localStorage.setItem('jinchi47_sound', this.on ? 'on' : 'off'); } catch (e) { /* 使えない環境 */ }
    return this.on;
  },
  makeNoise() {
    const n = this.ctx.sampleRate, buf = this.ctx.createBuffer(1, n, n), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  },
  /** 1秒あたりの音の数を制限（大きい音ほど多く使う） */
  allow(cost) {
    if (!this.on || !this.ctx) return false;
    if (this.ctx.state === 'suspended') { this.ctx.resume(); return false; }
    const now = this.ctx.currentTime;
    this.budget = Math.min(10, this.budget + (now - this.last) * 10);
    this.last = now;
    if (this.budget < cost) return false;
    this.budget -= cost;
    return true;
  },
  burst(dur, f0, f1, vol, q, delay = 0) {
    const c = this.ctx, t = c.currentTime + delay;
    const src = c.createBufferSource(); src.buffer = this.noise; src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const flt = c.createBiquadFilter(); flt.type = 'bandpass'; flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, t); flt.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(flt); flt.connect(g); g.connect(this.master);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  },
  tone(freq, dur, vol, type = 'square', delay = 0) {
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  },
  /** 鉄砲（パン）：v は 0〜1 の大きさ（遠いほど小さく） */
  shot(v = 1) { if (this.allow(1)) this.burst(0.09, 2600, 700, 0.18 * v, 0.9); },
  /** 爆発（ドーン） */
  boom(v = 1) { if (this.allow(2.5)) { this.burst(0.7, 380, 45, 0.55 * v, 0.7); this.burst(0.25, 1500, 200, 0.2 * v, 0.6); } },
  /** 旗を守りきった：上がっていく和音 */
  fanfare() { if (this.allow(0)) [523, 659, 784, 1047].forEach((f, k) => this.tone(f, 0.35, 0.12, 'triangle', k * 0.12)); },
  /** ほら貝（出陣）：低い音が2回、ゆっくり上がって消える */
  conch() {
    if (!this.allow(0)) return;
    const c = this.ctx;
    for (const [f, d] of [[146, 0], [164, 0.9]]) {
      const t = c.currentTime + d, o = c.createOscillator(), o2 = c.createOscillator(), g = c.createGain(), flt = c.createBiquadFilter();
      o.type = 'sawtooth'; o2.type = 'triangle';
      o.frequency.setValueAtTime(f * 0.9, t); o.frequency.linearRampToValueAtTime(f, t + 0.25); o2.frequency.setValueAtTime(f * 2, t);
      flt.type = 'lowpass'; flt.frequency.value = 900; flt.Q.value = 3;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.14, t + 0.2); g.gain.setValueAtTime(0.14, t + 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
      o.connect(flt); o2.connect(flt); flt.connect(g); g.connect(this.master);
      o.start(t); o2.start(t); o.stop(t + 0.9); o2.stop(t + 0.9);
    }
  },
  /** 警告（宣戦布告など） */
  alert() { if (this.allow(0)) [440, 330, 440, 330].forEach((f, k) => this.tone(f, 0.16, 0.08, 'square', k * 0.18)); },
};
