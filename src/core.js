/* 47都道府県対抗 陣取り合戦（RTS版）— 単一HTML
 * 構成: core.js（CONFIG・ユーティリティ・マップ・カメラ・WebGL描画）/ rts_sim.js（ルール・AI）/ app.js（画面・入力・ステートマシン）
 * tools/build.py がこれらを1つの <script> にまとめる。
 */

// =====================================================================
// CONFIG（調整値）
// =====================================================================
const CONFIG = {
  // ---- 参加者（1人＝地図上の1部隊。全国で約1000部隊）
  PARTICIPANTS_PER_MILLION: 8,   // 人口100万人あたりの参加者数
  MIN_PARTICIPANTS: 3,
  // ---- 進行
  TICK: 0.1,                     // シミュレーションの固定刻み（秒）
  WIN_RATIO: 0.5,                // 全国の陸地のこの割合を支配すれば勝利
  PATH_BUDGET: 30,               // 1刻みあたりの経路探索の上限（AI）
  // ---- 部隊
  UNIT_HP: 100,
  UNIT_SPEED: 5,                 // マス/秒
  UNIT_DPS: 12,                  // 1秒あたりの攻撃力
  ATTACK_RANGE: 2.5,             // 攻撃が届く距離（マス）
  AGGRO_RANGE: 9,                // AIはこの距離の敵部隊に向かっていく
  HOME_BONUS: 1.25,              // 自県の領土で戦うと攻撃力アップ
  ATTRITION: 0.6,                // 敵の領土にいると毎秒減るHP
  REGEN: 3,                      // 自県の領土で戦っていないと毎秒回復するHP
  RESPAWN: 8,                    // 倒されてから近くの自県の拠点で復活するまでの秒数
  // ---- 拠点（県庁・町・砦）。拠点の周りが領土になる
  CAPTURE_RADIUS: 6,             // この距離にいる部隊が占領・守備に参加する
  CAPTURE_NEED: { capital: 150, town: 60, fort: 40 },   // 占領に必要なポイント（毎秒、攻撃側の部隊数ぶん増える）
  CAPTURE_MAX_RATE: 20,          // 1秒に増えるポイントの上限
  CAPTURE_DECAY: 15,             // 守備側がいる・誰もいないと毎秒減るポイント
  RECENT_HATCH: 15,              // 占領されてからこの秒数は斜線で表示
  // ---- 軍資金・砦
  START_GOLD: 300,               // 単位は「億」
  INCOME_LAND: 0.6,              // 毎秒の収入：0.6 × √(領土マス/100)
  INCOME_NODE: 0.15,             //           ＋ 拠点1つあたり
  FORT_COST: 400,
  FORT_RADIUS: 24,               // 砦が国境を押し出す距離（マス）
  FORT_MIN_DIST: 16,             // ほかの拠点からこれ以上離して建てる
  // ---- AI
  AI_PLAN_INTERVAL: 4,           // 県の作戦を見直す間隔（秒）
  AI_TARGET_TIMEOUT: 120,        // 攻め先をあきらめるまでの秒数
  AI_FORT_INTERVAL: 60,          // 県が砦を建てる最短間隔（秒）
  AI_DEFENDER_RATIO: 0.25,       // 守備担当の部隊の割合
  // ---- 画面
  CAMERA_PITCH: 55, TOP_PITCH: 90, TITLE_PITCH: 80, FOV: 45,
  ZOOM_MIN: 5, ZOOM_MAX: 9000,
  OWNER_MIX: 0.52, OWNER_MIX_TOP: 0.88,
  LOG_MAX: 4, BANNER_MS: 1800, MINIMAP_REFRESH: 1.0, MAX_DPR: 2, HUD_REFRESH: 0.25,
};
const WASTE = 48;             // 焦土（持ち主なし）を表す持ち主ID
const WASTE_COLOR = '#4a4038';

// =====================================================================
// ユーティリティ
// =====================================================================
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fmt = (n) => n.toLocaleString('ja-JP');
const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const nextFrame = () => new Promise((r) => setTimeout(r, 0));
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// =====================================================================
// マップデータ（RLE + base64 を展開）
// =====================================================================
function b64ToBytes(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function rleDecode(b64, n) {
  const src = b64ToBytes(b64);
  const out = new Uint8Array(n);
  let p = 0, o = 0;
  while (p < src.length) {
    const v = src[p++];
    let len = 0, shift = 0, b;
    do { b = src[p++]; len |= (b & 127) << shift; shift += 7; } while (b & 128);
    out.fill(v, o, o + len);
    o += len;
  }
  if (o !== n) throw new Error('RLE size mismatch ' + o + ' / ' + n);
  return out;
}
function decodeLines(list) {
  // [x0,y0,dx,dy,...] (1/4マス単位) → Float32Array の折れ線
  return list.map((flat) => {
    const pts = new Float32Array(flat.length);
    let x = 0, y = 0;
    for (let i = 0; i < flat.length; i += 2) {
      x += flat[i]; y += flat[i + 1];
      pts[i] = x / 4; pts[i + 1] = y / 4;
    }
    return pts;
  });
}

const TERRAIN_NAMES = ['海', '平地', '森', '山', '市街地'];
const TERRAIN_COLORS = {
  1: [164, 196, 112], 2: [80, 130, 72], 3: [132, 114, 94], 4: [180, 178, 188],
  9: [232, 238, 242], 10: [198, 214, 216], 11: [246, 248, 251], 12: [210, 212, 220],
};

class MapData {
  constructor(raw) {
    this.raw = raw;
    this.W = raw.W; this.H = raw.H; this.N = raw.W * raw.H;
    this.prefs = [null];
    for (const p of raw.prefs) this.prefs[p.id] = p;
    this.landCells = raw.landCells;
  }
  async decode(progress) {
    const { N, W } = this;
    progress(0.1, '県のマスを展開中…'); await nextFrame();
    this.initPref = rleDecode(this.raw.pref, N);
    progress(0.25, '地形を展開中…'); await nextFrame();
    this.terrain = rleDecode(this.raw.terrain, N);
    this.coast = decodeLines(this.raw.coast);
    this.border = decodeLines(this.raw.border);
    // 連絡マス（隣接扱い）
    this.linkMap = new Map();
    const addLink = (a, b) => {
      if (!this.linkMap.has(a)) this.linkMap.set(a, []);
      if (!this.linkMap.has(b)) this.linkMap.set(b, []);
      this.linkMap.get(a).push(b); this.linkMap.get(b).push(a);
    };
    this.linkName = new Map();
    for (const l of this.raw.links) {
      addLink(l.a, l.b);
      this.linkName.set(l.a, l.name); this.linkName.set(l.b, l.name);
    }
    for (const [a, b] of this.raw.autoLinks) addLink(a, b);
    this.capitalCell = this.prefs.map((p) => (p ? p.capital : -1));
    this.capitalOf = new Map();
    for (const p of this.prefs) if (p) this.capitalOf.set(p.capital, p.id);
    this.initCounts = new Int32Array(48);
    const ip = this.initPref;
    for (let i = 0; i < N; i++) if (ip[i]) this.initCounts[ip[i]]++;
    this.xy = (i) => [i % W, (i / W) | 0];
  }
  isLand(i) { return this.initPref[i] !== 0; }
  ownerName(o) { return o === WASTE ? '焦土（持ち主なし）' : this.prefs[o].name; }
  ownerColor(o) { return o === WASTE ? WASTE_COLOR : this.prefs[o].color; }
  paletteColors() { const c = this.prefs.map((p) => (p ? p.color : null)); c[WASTE] = WASTE_COLOR; return c; }
  /** グリッド座標 → 本来の経度緯度（インセットはずらす前の位置に戻す） */
  lonLat(x, y) {
    let lon = this.raw.lon0 + (x + 0.5) * this.raw.dlon;
    let lat = this.raw.latTop - (y + 0.5) * this.raw.dlat;
    for (const s of this.raw.shiftRects) {
      if (x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1) { lon -= s.dlon; lat -= s.dlat; break; }
    }
    return [lon, lat];
  }
}

// =====================================================================
// カメラ（斜め見下ろし／真上、北が上）
// =====================================================================
class Camera {
  constructor() {
    this.tx = 1200; this.tz = 1080; this.dist = 3000; this.pitch = CONFIG.CAMERA_PITCH;
    this.goal = null;             // flyTo アニメーション
    this.pitchGoal = this.pitch;
    this.fovY = CONFIG.FOV * Math.PI / 180;
    this.w = 1; this.h = 1;
    this.vp = new Float32Array(16);
    this.bounds = [0, 0, 2400, 2160];
  }
  setViewport(w, h) { this.w = w; this.h = h; }
  /** (x,z) が画面の縦位置 anchorY(0..1) に来るように移動する */
  flyTo(x, z, dist, anchorY) {
    const d = dist == null ? this.dist : clamp(dist, CONFIG.ZOOM_MIN, CONFIG.ZOOM_MAX);
    let ox = 0, oz = 0;
    if (anchorY != null && anchorY !== 0.5) {
      const save = [this.tx, this.tz, this.dist, this.pitch];
      this.tx = 0; this.tz = 0; this.dist = d; this.pitch = this.pitchGoal;
      const a = this.groundAt(this.w / 2, this.h * anchorY);
      if (a) { ox = a.x; oz = a.z; }
      [this.tx, this.tz, this.dist, this.pitch] = save;
    }
    this.goal = { x: x - ox, z: z - oz, dist: d, t: 0, sx: this.tx, sz: this.tz, sd: this.dist };
  }
  update(dt) {
    if (this.goal) {
      const g = this.goal;
      g.t = Math.min(1, g.t + dt / 0.7);
      const e = g.t < 0.5 ? 4 * g.t * g.t * g.t : 1 - Math.pow(-2 * g.t + 2, 3) / 2;
      this.tx = g.sx + (g.x - g.sx) * e;
      this.tz = g.sz + (g.z - g.sz) * e;
      this.dist = Math.exp(Math.log(g.sd) + (Math.log(g.dist) - Math.log(g.sd)) * e);
      if (g.t >= 1) this.goal = null;
    }
    this.pitch += (this.pitchGoal - this.pitch) * Math.min(1, dt * 7);
    if (Math.abs(this.pitch - this.pitchGoal) < 0.01) this.pitch = this.pitchGoal;
    this.clampTarget();
  }
  clampTarget() {
    const [x0, z0, x1, z1] = this.bounds;
    this.dist = clamp(this.dist, CONFIG.ZOOM_MIN, CONFIG.ZOOM_MAX);
    // 引いているときほど注視点を地図の外まで動かせる（画面の端に地図を寄せられるように）
    const m = 100 + this.dist * 0.5;
    this.tx = clamp(this.tx, x0 - m, x1 + m);
    this.tz = clamp(this.tz, z0 - m, z1 + m);
  }
  basis() {
    const p = this.pitch * Math.PI / 180, s = Math.sin(p), c = Math.cos(p);
    const eye = [this.tx, this.dist * s, this.tz + this.dist * c];
    const f = [0, -s, -c], r = [1, 0, 0], u = [0, c, -s];
    return { eye, f, r, u };
  }
  compute() {
    const { eye, f, r, u } = this.basis();
    const view = [
      r[0], u[0], -f[0], 0,
      r[1], u[1], -f[1], 0,
      r[2], u[2], -f[2], 0,
      -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]),
      -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]),
      (f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]), 1];
    const aspect = this.w / this.h;
    const near = Math.max(0.5, this.dist * 0.05), far = this.dist * 6 + 500;
    const t = 1 / Math.tan(this.fovY / 2);
    const proj = [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
    mat4mul(this.vp, proj, view);
    return this.vp;
  }
  /** 画面座標(CSS px) → 地面との交点 {x,z}（なければnull） */
  groundAt(sx, sy) {
    const { eye, f, r, u } = this.basis();
    const th = Math.tan(this.fovY / 2), aspect = this.w / this.h;
    const nx = (sx / this.w) * 2 - 1, ny = 1 - (sy / this.h) * 2;
    const d = [f[0] + r[0] * nx * th * aspect + u[0] * ny * th,
      f[1] + r[1] * nx * th * aspect + u[1] * ny * th,
      f[2] + r[2] * nx * th * aspect + u[2] * ny * th];
    if (d[1] > -1e-6) return null;
    const t = -eye[1] / d[1];
    return { x: eye[0] + d[0] * t, z: eye[2] + d[2] * t };
  }
  /** 地面の点 → 画面座標(CSS px) */
  project(x, y, z, out) {
    const m = this.vp;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0.0001) return null;
    out[0] = (cx / cw * 0.5 + 0.5) * this.w;
    out[1] = (0.5 - cy / cw * 0.5) * this.h;
    return out;
  }
  /** 画面中央付近での 1マスあたりのピクセル数 */
  cellPx() { return this.h / (2 * this.dist * Math.tan(this.fovY / 2)); }
  panBy(sx0, sy0, sx1, sy1) {
    const a = this.groundAt(sx0, sy0), b = this.groundAt(sx1, sy1);
    if (!a || !b) return;
    this.goal = null;
    this.tx += a.x - b.x; this.tz += a.z - b.z;
    this.clampTarget();
  }
  zoomAt(sx, sy, factor) {
    const before = this.groundAt(sx, sy);
    this.goal = null;
    this.dist = clamp(this.dist * factor, CONFIG.ZOOM_MIN, CONFIG.ZOOM_MAX);
    const after = this.groundAt(sx, sy);
    if (before && after) { this.tx += before.x - after.x; this.tz += before.z - after.z; }
    this.clampTarget();
  }
}
function mat4mul(out, a, b) {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
    }
  }
  return out;
}

// =====================================================================
// WebGL 描画
// =====================================================================
const GROUND_VS = `
attribute vec2 aPos;
uniform mat4 uVP;
varying vec2 vWorld;
void main(){ vWorld = aPos; gl_Position = uVP * vec4(aPos.x, 0.0, aPos.y, 1.0); }`;

const GROUND_FS = `
#ifdef HAS_DERIV
#extension GL_OES_standard_derivatives : enable
#endif
precision highp float;
uniform sampler2D uTerrain;
uniform sampler2D uOwner;
uniform sampler2D uPalette;
uniform vec2 uGrid;
uniform float uMix;
uniform float uMe;
uniform float uBlink;
uniform float uCpp;
uniform vec2 uSel;
varying vec2 vWorld;
float ownerAt(vec2 c){ return floor(texture2D(uOwner, (c + 0.5) / uGrid).r * 255.0 + 0.5); }
// となりの自県マス（毒ガスで汚染されたマスからは攻撃できないので除く）
float isMe(vec2 c){
  vec4 t = texture2D(uOwner, (c + 0.5) / uGrid);
  float gas = step(31.5, mod(floor(t.g * 255.0 + 0.5), 64.0));
  return (1.0 - step(0.5, abs(floor(t.r * 255.0 + 0.5) - uMe))) * (1.0 - gas);
}
void main(){
  vec3 sea = vec3(0.12, 0.24, 0.39);
  vec2 cell = floor(vWorld);
#ifdef HAS_DERIV
  vec2 fw = fwidth(vWorld);
  float cpp = max(max(fw.x, fw.y), 1e-4);
#else
  float cpp = uCpp;
#endif
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= uGrid.x || cell.y >= uGrid.y) { gl_FragColor = vec4(0.124, 0.241, 0.390, 1.0); return; }
  vec2 uv = (cell + 0.5) / uGrid;
  vec4 o = texture2D(uOwner, uv);
  float id = floor(o.r * 255.0 + 0.5);
  vec3 terr = texture2D(uTerrain, uv).rgb;
  vec3 col = terr;
  if (id > 0.5) {
    vec3 pc = texture2D(uPalette, vec2((id + 0.5) / 64.0, 0.5)).rgb;
    float l = dot(terr, vec3(0.299, 0.587, 0.114));
    vec3 tint = pc * (0.6 + 0.52 * l);
    col = mix(terr, tint, uMix);
    // G: 128=今日変わった, 64=放射能で立ち入り不可, 32=毒ガス
    float gv = floor(o.g * 255.0 + 0.5);
    float changed = step(127.5, gv);
    float fallout = step(63.5, mod(gv, 128.0));
    float gas = step(31.5, mod(gv, 64.0));
    if (id > 47.5) col = mix(terr * 0.35, vec3(0.30, 0.25, 0.21), 0.75);   // 焦土
    if (fallout > 0.5) col = mix(col, vec3(0.62, 0.86, 0.12), 0.3);
    if (gas > 0.5) col = mix(col, vec3(0.62, 0.32, 0.95), 0.42);
    // その日に持ち主が変わったマス：斜線
    if (changed > 0.5) {
      float s = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 10.0));
      col = mix(col, vec3(1.0), s * 0.45);
    }
    // 防御中のマス
    if (o.b > 0.5) col = mix(col, vec3(0.78, 0.96, 1.0), 0.42);
    // 攻撃できるマス：赤く点滅
    if (uBlink > 0.0 && abs(id - uMe) > 0.5 && changed + fallout < 0.5 && o.b < 0.5) {
      float adj = step(0.5, o.a);
      adj += isMe(cell + vec2(-1.0, -1.0)) + isMe(cell + vec2(0.0, -1.0)) + isMe(cell + vec2(1.0, -1.0));
      adj += isMe(cell + vec2(-1.0, 0.0)) + isMe(cell + vec2(1.0, 0.0));
      adj += isMe(cell + vec2(-1.0, 1.0)) + isMe(cell + vec2(0.0, 1.0)) + isMe(cell + vec2(1.0, 1.0));
      // 赤⇔白っぽく明滅させ、赤系の自県とも見分けられるようにする
      if (adj > 0.5) col = mix(mix(col, vec3(1.0, 0.92, 0.88), 0.45 * (1.0 - uBlink)), vec3(1.0, 0.06, 0.03), 0.8 * uBlink);
    }
    // 拡大時だけマスの境目をうっすら
    vec2 f = fract(vWorld);
    vec2 e = min(f, 1.0 - f);
    float ed = min(e.x, e.y);
    float show = clamp((1.0 / cpp - 6.0) / 14.0, 0.0, 1.0);
    float line = 1.0 - smoothstep(0.0, cpp * 1.2, ed);
    col *= 1.0 - line * show * 0.3;
  }
  if (cell == uSel) {
    vec2 f = fract(vWorld);
    vec2 e = min(f, 1.0 - f);
    if (min(e.x, e.y) < max(0.1, cpp * 2.5)) col = vec3(1.0, 0.9, 0.15);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const LINE_VS = `
attribute vec2 aA;
attribute vec2 aB;
attribute vec3 aInfo; // side, end, dist
uniform mat4 uVP;
uniform vec2 uViewport;
uniform float uWidth;
varying float vDist;
void main(){
  vec4 pa = uVP * vec4(aA.x, 0.0, aA.y, 1.0);
  vec4 pb = uVP * vec4(aB.x, 0.0, aB.y, 1.0);
  vec4 p = aInfo.y < 0.5 ? pa : pb;
  vec2 sa = pa.xy / pa.w * uViewport, sb = pb.xy / pb.w * uViewport;
  vec2 d = sb - sa;
  float L = length(d);
  d = L > 1e-5 ? d / L : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  p.xy += n * aInfo.x * uWidth / uViewport * p.w;
  gl_Position = p;
  vDist = aInfo.z;
}`;
const LINE_FS = `
precision mediump float;
uniform vec4 uColor;
uniform float uDash;
varying float vDist;
void main(){
  if (uDash > 0.0 && fract(vDist / uDash) > 0.55) discard;
  gl_FragColor = uColor;
}`;

// 箱（建物・部隊）：インスタンスごとに位置・大きさ・色を持つ
const BOX_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec3 iOff;
attribute vec3 iScale;
attribute vec3 iColor;
uniform mat4 uVP;
varying vec3 vN;
varying vec3 vC;
void main(){ vN = aNrm; vC = iColor; gl_Position = uVP * vec4(aPos * iScale + iOff, 1.0); }`;
const BOX_FS = `
precision mediump float;
varying vec3 vN;
varying vec3 vC;
void main(){
  float l = 0.45 + 0.55 * max(dot(normalize(vN), normalize(vec3(-0.35, 0.85, 0.45))), 0.0);
  gl_FragColor = vec4(vC * l, 1.0);
}`;

function compile(gl, vs, fs, defs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  const v = mk(gl.VERTEX_SHADER, vs), f = mk(gl.FRAGMENT_SHADER, (defs || '') + fs);
  gl.attachShader(p, v); gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  gl.deleteShader(v); gl.deleteShader(f);
  const u = {}, a = {};
  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) { const info = gl.getActiveAttrib(p, i); a[info.name] = gl.getAttribLocation(p, info.name); }
  return { p, u, a };
}

class Renderer {
  constructor(canvas, map) {
    this.canvas = canvas;
    this.map = map;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGLが使えません');
    this.gl = gl;
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (maxTex < Math.max(map.W, map.H)) throw new Error(`この端末はテクスチャサイズ ${maxTex} までしか扱えません`);
    const deriv = gl.getExtension('OES_standard_derivatives');
    const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    let fs = GROUND_FS;
    if (!hp || hp.precision === 0) fs = fs.replace('precision highp float;', 'precision mediump float;');
    this.ground = compile(gl, GROUND_VS, fs, deriv ? '#define HAS_DERIV\n' : '');
    this.line = compile(gl, LINE_VS, LINE_FS);
    this.box = compile(gl, BOX_VS, BOX_FS);
    this.instExt = gl.getExtension('ANGLE_instanced_arrays');
    this.instBuf = gl.createBuffer();
    this.dirty = new Set();
    this.texel = new Uint8Array(4);
    this.me = 0;
    this.game = null;
    this.buildGround();
    this.buildLines();
    this.buildBox();
    this.palette = gl.createTexture();
    this.ownerTex = gl.createTexture();
    this.terrainTex = gl.createTexture();
  }
  dispose() {
    const gl = this.gl;
    for (const t of [this.palette, this.ownerTex, this.terrainTex]) gl.deleteTexture(t);
    for (const b of [this.groundBuf, this.lineBuf, this.boxBuf, this.instBuf]) gl.deleteBuffer(b);
    for (const p of [this.ground, this.line, this.box]) gl.deleteProgram(p.p);
  }
  texParams(gl) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  /** 地形テクスチャ（マスごとに少し明るさをばらつかせる。マス内は単色） */
  uploadTerrain() {
    const { gl, map } = this;
    const { W, H, N, terrain } = map;
    const rgb = new Uint8Array(N * 3);
    const pal = new Uint8Array(16 * 3);
    for (const k in TERRAIN_COLORS) pal.set(TERRAIN_COLORS[k], k * 3);
    for (let i = 0; i < N; i++) {
      const t = terrain[i];
      if (!t) { // 海：わずかなゆらぎ
        const v = ((i * 2654435761) >>> 27) & 3;
        rgb[i * 3] = 30 + v; rgb[i * 3 + 1] = 60 + v; rgb[i * 3 + 2] = 98 + v;
        continue;
      }
      const h = (((i * 2654435761) ^ (i >>> 7)) >>> 24) / 255; // 0..1
      const k = 0.93 + h * 0.12;
      rgb[i * 3] = Math.min(255, pal[t * 3] * k);
      rgb[i * 3 + 1] = Math.min(255, pal[t * 3 + 1] * k);
      rgb[i * 3 + 2] = Math.min(255, pal[t * 3 + 2] * k);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.terrainTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, W, H, 0, gl.RGB, gl.UNSIGNED_BYTE, rgb);
    this.texParams(gl);
  }
  setPalette(colors) {
    const gl = this.gl;
    const data = new Uint8Array(64 * 4);
    colors.forEach((c, i) => { if (c) { const [r, g, b] = hexToRgb(c); data.set([r, g, b, 255], i * 4); } });
    gl.bindTexture(gl.TEXTURE_2D, this.palette);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.texParams(gl);
  }
  /** 持ち主テクスチャ: R=持ち主, G=今日変わった, B=防御中, A=連絡マス経由で自県に隣接 */
  attachGame(game, me) {
    this.game = game; this.me = me;
    this.dirty.clear();
    const { gl, map } = this;
    const { N, W, H } = map;
    const data = new Uint8Array(N * 4);
    for (let i = 0; i < N; i++) this.computeTexel(i, data, i * 4);
    gl.bindTexture(gl.TEXTURE_2D, this.ownerTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.texParams(gl);
  }
  /** 持ち主テクスチャ: R=持ち主, G=128 なら最近占領されたマス（斜線） */
  computeTexel(i, out, o) {
    const g = this.game, map = this.map;
    out[o] = g ? g.owner[i] : map.initPref[i];
    out[o + 1] = g && g.isRecent(i) ? 128 : 0;
    out[o + 2] = 0;
    out[o + 3] = 0;
  }
  cellChanged(i) {
    this.dirty.add(i);
    const ls = this.map.linkMap.get(i);
    if (ls) for (const j of ls) this.dirty.add(j);
  }
  flush() {
    if (!this.dirty.size) return;
    const { gl, map } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.ownerTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (this.dirty.size > 20000) {   // 大量に変わったときはまとめて作り直す
      const g = this.game; this.dirty.clear(); this.attachGame(g, this.me); return;
    }
    for (const i of this.dirty) {
      this.computeTexel(i, this.texel, 0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, i % map.W, (i / map.W) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.texel);
    }
    this.dirty.clear();
  }
  buildGround() {
    const gl = this.gl, { W, H } = this.map;
    const m = 4000;
    const v = new Float32Array([-m, -m, W + m, -m, -m, H + m, W + m, H + m]);
    this.groundBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.groundBuf);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
  }
  /** 県境・海岸線・連絡線・インセット枠を「太さを持つ線分」の三角形にする */
  buildLines() {
    const gl = this.gl, map = this.map;
    const verts = [];
    this.lineGroups = {};
    const pushSeg = (ax, ay, bx, by, d0, d1) => {
      // 6頂点 × (aA2, aB2, info3)
      const q = [[-1, 0, d0], [1, 0, d0], [-1, 1, d1], [1, 0, d0], [1, 1, d1], [-1, 1, d1]];
      for (const [side, end, d] of q) verts.push(ax, ay, bx, by, side, end, d);
    };
    const group = (name, fn) => {
      const start = verts.length / 7;
      fn();
      this.lineGroups[name] = [start, verts.length / 7 - start];
    };
    const polyline = (pts) => {
      let d = 0;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const L = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
        pushSeg(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], d, d + L);
        d += L;
      }
    };
    group('coast', () => map.coast.forEach(polyline));
    group('border', () => map.border.forEach(polyline));
    const W = map.W;
    const c = (i) => [(i % W) + 0.5, ((i / W) | 0) + 0.5];
    this.linkStubs = [];
    group('links', () => {
      for (const l of map.raw.links) {
        const [ax, ay] = c(l.a), [bx, by] = c(l.b);
        const L = Math.hypot(bx - ax, by - ay);
        if (l.stub) {
          // インセットへの長い航路は両端に短い矢印線だけ描く
          const ux = (bx - ax) / L, uy = (by - ay) / L, s = 45;
          pushSeg(ax, ay, ax + ux * s, ay + uy * s, 0, s);
          pushSeg(bx, by, bx - ux * s, by - uy * s, 0, s);
          this.linkStubs.push({ x: ax + ux * s, y: ay + uy * s, name: l.name, to: 'b' });
          this.linkStubs.push({ x: bx - ux * s, y: by - uy * s, name: l.name, to: 'a' });
        } else {
          pushSeg(ax, ay, bx, by, 0, L);
        }
      }
    });
    group('auto', () => {
      for (const [a, b] of map.raw.autoLinks) {
        const [ax, ay] = c(a), [bx, by] = c(b);
        const L = Math.hypot(bx - ax, by - ay);
        if (L > 2) pushSeg(ax, ay, bx, by, 0, L);
      }
    });
    group('inset', () => {
      for (const r of map.raw.insets) polyline(r.poly);
    });
    this.lineBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  }
  buildBox() {
    const gl = this.gl;
    // 単位立方体（底面中心が原点、高さ1）
    const v = [];
    const F = [
      [[0, 1, 0], [[-.5, 1, -.5], [.5, 1, -.5], [.5, 1, .5], [-.5, 1, .5]]],
      [[0, 0, 1], [[-.5, 0, .5], [.5, 0, .5], [.5, 1, .5], [-.5, 1, .5]]],
      [[0, 0, -1], [[.5, 0, -.5], [-.5, 0, -.5], [-.5, 1, -.5], [.5, 1, -.5]]],
      [[1, 0, 0], [[.5, 0, .5], [.5, 0, -.5], [.5, 1, -.5], [.5, 1, .5]]],
      [[-1, 0, 0], [[-.5, 0, -.5], [-.5, 0, .5], [-.5, 1, .5], [-.5, 1, -.5]]],
    ];
    for (const [n, q] of F) for (const k of [0, 1, 2, 0, 2, 3]) v.push(...q[k], ...n);
    this.boxCount = v.length / 6;
    this.boxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
  }
  resize(w, h, dpr) {
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
  }
  render(cam, opt) {
    const gl = this.gl, map = this.map;
    this.flush();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.124, 0.241, 0.390, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const vp = cam.compute();
    const cpp = 1 / cam.cellPx();
    // --- 地面
    const g = this.ground;
    gl.useProgram(g.p);
    gl.disable(gl.DEPTH_TEST);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.groundBuf);
    gl.enableVertexAttribArray(g.a.aPos);
    gl.vertexAttribPointer(g.a.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(g.u.uVP, false, vp);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.terrainTex); gl.uniform1i(g.u.uTerrain, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.ownerTex); gl.uniform1i(g.u.uOwner, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.palette); gl.uniform1i(g.u.uPalette, 2);
    gl.uniform2f(g.u.uGrid, map.W, map.H);
    gl.uniform1f(g.u.uMix, opt.mix);
    gl.uniform1f(g.u.uMe, this.me);
    gl.uniform1f(g.u.uBlink, opt.blink);
    if (g.u.uCpp) gl.uniform1f(g.u.uCpp, cpp);
    gl.uniform2f(g.u.uSel, opt.sel >= 0 ? opt.sel % map.W : -9, opt.sel >= 0 ? (opt.sel / map.W) | 0 : -9);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(g.a.aPos);
    // --- 線
    const L = this.line;
    gl.useProgram(L.p);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    for (const k of ['aA', 'aB', 'aInfo']) gl.enableVertexAttribArray(L.a[k]);
    gl.vertexAttribPointer(L.a.aA, 2, gl.FLOAT, false, 28, 0);
    gl.vertexAttribPointer(L.a.aB, 2, gl.FLOAT, false, 28, 8);
    gl.vertexAttribPointer(L.a.aInfo, 3, gl.FLOAT, false, 28, 16);
    gl.uniformMatrix4fv(L.u.uVP, false, vp);
    gl.uniform2f(L.u.uViewport, this.canvas.width / 2, this.canvas.height / 2);
    const dpr = this.canvas.width / cam.w;
    const draw = (grp, width, rgba, dashPx) => {
      const [s, n] = this.lineGroups[grp];
      if (!n) return;
      gl.uniform1f(L.u.uWidth, width * dpr * 0.5);
      gl.uniform4f(L.u.uColor, rgba[0], rgba[1], rgba[2], rgba[3]);
      gl.uniform1f(L.u.uDash, dashPx ? dashPx * cpp : 0);
      gl.drawArrays(gl.TRIANGLES, s, n);
    };
    const zoomIn = clamp((cam.cellPx() - 0.3) / 1.5, 0, 1);
    draw('coast', 1.3 + zoomIn, [0.06, 0.12, 0.22, 0.85]);
    draw('border', 2.8 + zoomIn, [0, 0, 0, opt.top ? 0.55 : 0.4]);
    draw('border', 1.1 + zoomIn * 0.6, [1, 1, 1, opt.top ? 0.95 : 0.8]);
    if (cam.cellPx() > 1.2) draw('auto', 1.2, [1, 1, 1, 0.45], 8);
    draw('links', 3.2, [0.1, 0.05, 0, 0.6], 12);
    draw('links', 2.0, [1, 0.85, 0.2, 1], 12);
    draw('inset', 1.5, [1, 1, 1, 0.6], 10);
    for (const k of ['aA', 'aB', 'aInfo']) gl.disableVertexAttribArray(L.a[k]);
    gl.disable(gl.BLEND);
    // --- 建物・部隊（インスタンス描画。9 floats/個: 位置3・大きさ3・色3）
    const inst = opt.boxes;
    if (inst && inst.count) {
      const B = this.box, ext = this.instExt;
      gl.useProgram(B.p);
      gl.enable(gl.DEPTH_TEST);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.boxBuf);
      gl.enableVertexAttribArray(B.a.aPos); gl.enableVertexAttribArray(B.a.aNrm);
      gl.vertexAttribPointer(B.a.aPos, 3, gl.FLOAT, false, 24, 0);
      gl.vertexAttribPointer(B.a.aNrm, 3, gl.FLOAT, false, 24, 12);
      gl.uniformMatrix4fv(B.u.uVP, false, vp);
      const attrs = [B.a.iOff, B.a.iScale, B.a.iColor];
      if (ext) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
        gl.bufferData(gl.ARRAY_BUFFER, inst.data.subarray(0, inst.count * 9), gl.DYNAMIC_DRAW);
        attrs.forEach((a, k) => {
          gl.enableVertexAttribArray(a);
          gl.vertexAttribPointer(a, 3, gl.FLOAT, false, 36, k * 12);
          ext.vertexAttribDivisorANGLE(a, 1);
        });
        ext.drawArraysInstancedANGLE(gl.TRIANGLES, 0, this.boxCount, inst.count);
        attrs.forEach((a) => { ext.vertexAttribDivisorANGLE(a, 0); gl.disableVertexAttribArray(a); });
      } else {
        // 拡張が無い端末：1個ずつ定数属性で描く
        const d = inst.data;
        for (let k = 0; k < inst.count; k++) {
          const o = k * 9;
          gl.vertexAttrib3f(attrs[0], d[o], d[o + 1], d[o + 2]);
          gl.vertexAttrib3f(attrs[1], d[o + 3], d[o + 4], d[o + 5]);
          gl.vertexAttrib3f(attrs[2], d[o + 6], d[o + 7], d[o + 8]);
          gl.drawArrays(gl.TRIANGLES, 0, this.boxCount);
        }
      }
      gl.disableVertexAttribArray(B.a.aPos); gl.disableVertexAttribArray(B.a.aNrm);
    }
    gl.disable(gl.DEPTH_TEST);
  }
}
