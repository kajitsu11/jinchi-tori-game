/* 47都道府県対抗 陣取り合戦（RTS版）— 単一HTML
 * 構成: core.js（CONFIG・ユーティリティ・マップ・カメラ・WebGL描画）/ rts_sim.js（ルール・AI）/ app.js（画面・入力・ステートマシン）
 * tools/build.py がこれらを1つの <script> にまとめる。
 */

// =====================================================================
// CONFIG（調整値）
// =====================================================================
const CONFIG = {
  // ---- 参加者（全国で約1000人。今はプレイヤー以外をAIが担当）
  PARTICIPANTS_PER_MILLION: 8,
  MIN_PARTICIPANTS: 3,
  // ---- 進行
  TICK: 0.1,                     // シミュレーションの固定刻み（秒）
  WIN_RATIO: 0.5,
  PATH_BUDGET: 20,               // 1刻みあたりの経路探索の上限
  // ---- 資源（1人あたり）
  START_RES: { food: 300, wood: 400, gold: 200 },
  BASE_INCOME: { food: 1, wood: 1.2, gold: 0.6 },    // 毎秒の基本収入
  CAPITAL_MAKE: { food: 1, wood: 1, gold: 1 },       // 県庁の収入（県のAIへ）
  LUMBER_PER_FOREST: 0.06,       // 製材所：周りの森1か所あたりの木材/秒
  LUMBER_MAX: 2,
  LUMBER_MIN_FOREST: 8,
  // ---- 兵士
  UNIT_HP: 100,
  UNIT_SPEED: 5,
  UNIT_DPS: 12,
  ATTACK_RANGE: 2.5,
  AGGRO_RANGE: 9,
  HOME_BONUS: 1.25,
  ATTRITION: 0.6,
  REGEN: 3,
  BUILDING_DPS_MULT: 0.6,        // 兵士が建物を壊すときの攻撃力の倍率
  START_UNITS_RATIO: 0.5,        // 開始時の兵士＝参加者数×これ
  UNIT_CAP_PER_PARTICIPANT: 2,   // 兵士の上限＝参加者×2＋拠点×1
  UNIT_CAP_PER_NODE: 1,
  CAPITAL_RANGE: 10, CAPITAL_DPS: 18,
  // ---- 拠点（県庁・町・砦）
  CAPTURE_RADIUS: 6,
  CAPTURE_NEED: { capital: 150, town: 60, fort: 80 },
  CAPTURE_MAX_RATE: 20,
  CAPTURE_DECAY: 15,
  RECENT_HATCH: 15,
  NODE_RADIUS: 24,               // 町・砦が国境を押し出す距離
  NODE_MIN_DIST: 16,             // 町・砦はほかの拠点からこれ以上離す
  // ---- 建物
  BUILD_GAP: 2.2,                // 建物どうしの最小間隔（マス）
  MAX_BUILDINGS_PER_PARTICIPANT: 5,
  // ---- AI
  AI_BUILD_INTERVAL: 3,          // 県のAI参加者10人で、この秒数に1回建てる
  AI_PLAN_INTERVAL: 4,
  AI_TARGET_TIMEOUT: 120,
  AI_DEFENDER_RATIO: 0.25,
  // ---- 画面
  CAMERA_PITCH: 52, TOP_PITCH: 90, TITLE_PITCH: 75, FOV: 40,
  ZOOM_MIN: 5, ZOOM_MAX: 9000,
  FILL: 0.1, FILL_TOP: 0.78,      // 領土の塗りの濃さ（斜め／真上）
  TREE_MAX: 7000,
  LOG_MAX: 4, BANNER_MS: 1800, MINIMAP_REFRESH: 1.0, MAX_DPR: 2, HUD_REFRESH: 0.25,
};
const RES_KEYS = ['food', 'wood', 'gold'];
const RES_ICON = { food: '🌾', wood: '🪵', gold: '💰' };
const RES_NAME = { food: '食料', wood: '木材', gold: '金' };
/** 建物の種類 */
const BUILDINGS = {
  farm: { name: '農場', icon: '🌾', cost: { wood: 60 }, hp: 150, desc: '食料 +1.2/秒（森を切り開くと半分・山には建てられない）', make: { food: 1.2 } },
  lumber: { name: '製材所', icon: '🪓', cost: { wood: 40, gold: 20 }, hp: 150, desc: '周りの森から木材（最大 +2/秒）', forest: true },
  market: { name: '市場', icon: '🏪', cost: { wood: 120 }, hp: 200, desc: '金 +1/秒', make: { gold: 1 } },
  barracks: { name: '兵舎', icon: '⚔️', cost: { wood: 150, gold: 50 }, hp: 350, desc: '食料30で兵士を訓練（8秒ごと）', train: 8, trainFood: 30 },
  tower: { name: '見張り塔', icon: '🗼', cost: { wood: 80, gold: 60 }, hp: 450, desc: '近くの敵兵を撃つ', range: 9, dps: 14 },
  town: { name: '町', icon: '🏘️', cost: { wood: 250, gold: 150 }, desc: '国境を広げる・金 +0.8/秒', node: true, make: { gold: 0.8 } },
  fort: { name: '砦', icon: '🏰', cost: { wood: 150, gold: 300 }, desc: '国境を広げ、近くの敵兵を撃つ', node: true, range: 10, dps: 22 },
};
const BUILD_ORDER = ['farm', 'lumber', 'market', 'barracks', 'tower', 'town', 'fort'];
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
// 自然な色（草原・森・岩・街は草原寄り、雪）
const TERRAIN_COLORS = {
  1: [130, 168, 78], 2: [70, 110, 52], 3: [132, 120, 96], 4: [140, 160, 90],
  9: [226, 231, 233], 10: [176, 196, 190], 11: [240, 242, 245], 12: [216, 222, 222],
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
    progress(0.35, '標高を展開中…');
    // 標高（PNG・半分の解像度）：ブラウザの画像デコーダで読み、明るさを取り出す
    const ev = this.raw.elev;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('標高データを読めません')); img.src = 'data:image/png;base64,' + ev.png; });
    const cv = document.createElement('canvas');
    cv.width = ev.w; cv.height = ev.h;
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0);
    const px = cx.getImageData(0, 0, ev.w, ev.h).data;
    this.elev = new Uint8Array(ev.w * ev.h);
    for (let k = 0; k < this.elev.length; k++) this.elev[k] = px[k * 4];
    this.elevW = ev.w; this.elevH = ev.h;
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

// 地面：なめらかな地形の色 × 標高の陰影 × 細かいゆらぎ。海は岸に近いほど浅い色。
// 領土は「うっすら塗り」＋「国境線」（真上ビューでは濃く塗る）。
const GROUND_FS = `
#ifdef HAS_DERIV
#extension GL_OES_standard_derivatives : enable
#endif
precision highp float;
uniform sampler2D uTerrain;   // RGB=地形の色, A=陸(1)/海(0)
uniform sampler2D uElev;      // L=標高, A=陸地への近さ（浅瀬用）
uniform sampler2D uOwner;     // R=持ち主, G=最近占領された
uniform sampler2D uPalette;
uniform vec2 uGrid;
uniform float uFill;
uniform float uMe;
uniform float uPlace;
uniform float uTime;
uniform float uCpp;
varying vec2 vWorld;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float ownerAt(vec2 w){ return floor(texture2D(uOwner, (floor(w) + 0.5) / uGrid).r * 255.0 + 0.5); }
void main(){
#ifdef HAS_DERIV
  vec2 fw = fwidth(vWorld);
  float cpp = max(max(fw.x, fw.y), 1e-4);
#else
  float cpp = uCpp;
#endif
  vec2 uv = vWorld / uGrid;
  vec3 deep = vec3(0.09, 0.25, 0.40);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { gl_FragColor = vec4(deep, 1.0); return; }
  vec4 t = texture2D(uTerrain, uv);
  vec4 e = texture2D(uElev, uv);
  // 標高から陰影（北西から光）
  vec2 px = 2.0 / uGrid;
  float hL = texture2D(uElev, uv - vec2(px.x, 0.0)).r, hR = texture2D(uElev, uv + vec2(px.x, 0.0)).r;
  float hU = texture2D(uElev, uv - vec2(0.0, px.y)).r, hD = texture2D(uElev, uv + vec2(0.0, px.y)).r;
  vec3 n = normalize(vec3((hL - hR) * 9.0, 1.0, (hU - hD) * 9.0));
  float shade = clamp(0.55 + 0.6 * dot(n, normalize(vec3(-0.55, 0.75, -0.45))), 0.45, 1.25);
  // 草原らしい細かいゆらぎ（拡大すると見える）
  float nz = noise(vWorld * 0.35) * 0.45 + noise(vWorld * 1.6) * 0.35 + noise(vWorld * 6.0) * 0.2 * clamp(1.5 - cpp * 2.0, 0.0, 1.0);
  vec3 land = t.rgb * (0.8 + 0.38 * nz) * shade;
  // 海：岸に近いほど浅い色、さざ波
  float near = e.a;
  vec3 shallow = vec3(0.24, 0.52, 0.58);
  vec3 water = mix(deep, shallow, near * near);
  water += (noise(vWorld * 0.8 + vec2(uTime * 0.15, uTime * 0.07)) - 0.5) * 0.04;
  float isLand = smoothstep(0.42, 0.58, t.a);
  float foam = smoothstep(0.25, 0.45, t.a) * (1.0 - isLand);
  vec3 col = mix(water + foam * 0.25, land, isLand);
  // 領土
  if (isLand > 0.01) {
    float id = ownerAt(vWorld);
    if (id > 0.5) {
      vec3 pc = texture2D(uPalette, vec2((id + 0.5) / 64.0, 0.5)).rgb;
      col = mix(col, pc, uFill * isLand);
      // 国境線：となりの持ち主が違えば、自分の側に自分の色の線を引く
      float w = max(0.35, cpp * 1.7);
      float a = ownerAt(vWorld + vec2(w, 0.0)), b = ownerAt(vWorld - vec2(w, 0.0));
      float c = ownerAt(vWorld + vec2(0.0, w)), d = ownerAt(vWorld - vec2(0.0, w));
      float edge = 0.0;
      if (a > 0.5 && abs(a - id) > 0.5) edge = 1.0;
      if (b > 0.5 && abs(b - id) > 0.5) edge = 1.0;
      if (c > 0.5 && abs(c - id) > 0.5) edge = 1.0;
      if (d > 0.5 && abs(d - id) > 0.5) edge = 1.0;
      if (edge > 0.5) col = mix(col, pc * 1.1 + 0.08, 0.9 * isLand);
      // 最近占領されたところは斜線
      if (texture2D(uOwner, (floor(vWorld) + 0.5) / uGrid).g > 0.5) {
        float s = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 12.0));
        col = mix(col, pc, s * 0.35);
      }
      // 建設モード：自県の領土を明るく、それ以外を暗く
      if (uPlace > 0.0) col = abs(id - uMe) < 0.5 ? mix(col, vec3(0.75, 1.0, 0.6), 0.12) : col * 0.7;
    }
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

// 建物・兵士・木：メッシュ（箱・屋根・円錐・円柱）をインスタンスごとに 位置・大きさ・色・向き で描く
const MESH_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec3 iOff;
attribute vec3 iScale;
attribute vec4 iColor;   // rgb + 向き(ラジアン)
uniform mat4 uVP;
varying vec3 vN;
varying vec3 vC;
void main(){
  float c = cos(iColor.w), s = sin(iColor.w);
  vec3 p = aPos * iScale;
  p = vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
  vN = vec3(c * aNrm.x - s * aNrm.z, aNrm.y, s * aNrm.x + c * aNrm.z);
  vC = iColor.rgb;
  gl_Position = uVP * vec4(p + iOff, 1.0);
}`;
const MESH_FS = `
precision mediump float;
varying vec3 vN;
varying vec3 vC;
void main(){
  float l = 0.5 + 0.6 * max(dot(normalize(vN), normalize(vec3(-0.55, 0.75, -0.45))), 0.0);
  gl_FragColor = vec4(vC * l, 1.0);
}`;
const INST_FLOATS = 10;

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

/** メッシュの形（底面中心が原点、高さ1、幅1） */
function buildMeshes() {
  const meshes = {};
  const tri = (out, a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    for (const p of [a, b, c]) out.push(p[0], p[1], p[2], nx, ny, nz);
  };
  const quad = (out, a, b, c, d) => { tri(out, a, b, c); tri(out, a, c, d); };
  // 箱
  const box = [];
  const h = 0.5;
  quad(box, [-h, 1, -h], [-h, 1, h], [h, 1, h], [h, 1, -h]);
  quad(box, [-h, 0, h], [h, 0, h], [h, 1, h], [-h, 1, h]);
  quad(box, [h, 0, -h], [-h, 0, -h], [-h, 1, -h], [h, 1, -h]);
  quad(box, [h, 0, h], [h, 0, -h], [h, 1, -h], [h, 1, h]);
  quad(box, [-h, 0, -h], [-h, 0, h], [-h, 1, h], [-h, 1, -h]);
  meshes.box = box;
  // 切妻屋根（x 方向に棟）
  const roof = [];
  quad(roof, [-h, 0, h], [h, 0, h], [h, 1, 0], [-h, 1, 0]);
  quad(roof, [h, 0, -h], [-h, 0, -h], [-h, 1, 0], [h, 1, 0]);
  tri(roof, [h, 0, h], [h, 0, -h], [h, 1, 0]);
  tri(roof, [-h, 0, -h], [-h, 0, h], [-h, 1, 0]);
  meshes.roof = roof;
  // 円錐（木の葉・塔の屋根）と円柱
  const cone = [], cyl = [], K = 8;
  for (let k = 0; k < K; k++) {
    const a0 = k / K * Math.PI * 2, a1 = (k + 1) / K * Math.PI * 2;
    const p0 = [Math.cos(a0) * h, 0, Math.sin(a0) * h], p1 = [Math.cos(a1) * h, 0, Math.sin(a1) * h];
    tri(cone, p1, p0, [0, 1, 0]);
    quad(cyl, p1, p0, [p0[0], 1, p0[2]], [p1[0], 1, p1[2]]);
    tri(cyl, [0, 1, 0], [p1[0], 1, p1[2]], [p0[0], 1, p0[2]]);
  }
  meshes.cone = cone;
  meshes.cyl = cyl;
  return meshes;
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
    this.mesh = compile(gl, MESH_VS, MESH_FS);
    this.instExt = gl.getExtension('ANGLE_instanced_arrays');
    this.instBuf = gl.createBuffer();
    this.dirty = new Set();
    this.texel = new Uint8Array(4);
    this.me = 0;
    this.game = null;
    this.buildGround();
    this.buildLines();
    this.meshBufs = {};
    for (const [k, v] of Object.entries(buildMeshes())) {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
      this.meshBufs[k] = { buf: b, count: v.length / 6 };
    }
    this.palette = gl.createTexture();
    this.ownerTex = gl.createTexture();
    this.terrainTex = gl.createTexture();
    this.elevTex = gl.createTexture();
  }
  dispose() {
    const gl = this.gl;
    for (const t of [this.palette, this.ownerTex, this.terrainTex, this.elevTex]) gl.deleteTexture(t);
    for (const b of [this.groundBuf, this.lineBuf, this.instBuf]) gl.deleteBuffer(b);
    for (const m of Object.values(this.meshBufs)) gl.deleteBuffer(m.buf);
    for (const p of [this.ground, this.line, this.mesh]) gl.deleteProgram(p.p);
  }
  texParams(gl, linear) {
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  /** 地形テクスチャ（自然な色。標高が高いほど岩っぽく）と、標高・浅瀬テクスチャ */
  uploadTerrain() {
    const { gl, map } = this;
    const { W, H, N, terrain } = map;
    const ew = map.elevW, eh = map.elevH, elev = map.elev;
    const rgba = new Uint8Array(N * 4);
    const pal = new Uint8Array(16 * 3);
    for (const k in TERRAIN_COLORS) pal.set(TERRAIN_COLORS[k], k * 3);
    const ROCK = [126, 112, 92];
    for (let i = 0; i < N; i++) {
      const t = terrain[i], o = i * 4;
      if (!t) { rgba[o] = 40; rgba[o + 1] = 90; rgba[o + 2] = 110; rgba[o + 3] = 0; continue; }
      const x = i % W, y = (i / W) | 0;
      const ev = elev[Math.min(eh - 1, y >> 1) * ew + Math.min(ew - 1, x >> 1)] / 255;   // 0..1（平方根スケール）
      const r = (t & 8) ? 0 : clamp((ev - 0.35) * 1.6, 0, 0.75);   // 高いところは岩の色に寄せる（雪は除く）
      rgba[o] = pal[t * 3] + (ROCK[0] - pal[t * 3]) * r;
      rgba[o + 1] = pal[t * 3 + 1] + (ROCK[1] - pal[t * 3 + 1]) * r;
      rgba[o + 2] = pal[t * 3 + 2] + (ROCK[2] - pal[t * 3 + 2]) * r;
      rgba[o + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.terrainTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    this.texParams(gl, true);
    // 標高(L) と 陸地への近さ(A)（半分の解像度。ぼかして浅瀬の幅にする）
    const near = new Float32Array(ew * eh);
    for (let y = 0; y < eh; y++) for (let x = 0; x < ew; x++) {
      const i = (y * 2) * W + x * 2;
      near[y * ew + x] = (map.initPref[i] || map.initPref[i + 1] || map.initPref[i + W] || map.initPref[i + W + 1]) ? 1 : 0;
    }
    const blur = (src, r) => {
      const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
      for (let y = 0; y < eh; y++) { let s = 0; for (let x = -r; x < ew + r; x++) { if (x + r < ew) s += src[y * ew + x + r]; if (x - r - 1 >= 0) s -= src[y * ew + x - r - 1]; if (x >= 0 && x < ew) tmp[y * ew + x] = s / (2 * r + 1); } }
      for (let x = 0; x < ew; x++) { let s = 0; for (let y = -r; y < eh + r; y++) { if (y + r < eh) s += tmp[(y + r) * ew + x]; if (y - r - 1 >= 0) s -= tmp[(y - r - 1) * ew + x]; if (y >= 0 && y < eh) out[y * ew + x] = s / (2 * r + 1); } }
      return out;
    };
    const nb = blur(blur(near, 5), 5);
    const la = new Uint8Array(ew * eh * 2);
    for (let k = 0; k < ew * eh; k++) { la[k * 2] = elev[k]; la[k * 2 + 1] = Math.min(255, nb[k] * 2.2 * 255); }
    gl.bindTexture(gl.TEXTURE_2D, this.elevTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, ew, eh, 0, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, la);
    this.texParams(gl, true);
  }
  setPalette(colors) {
    const gl = this.gl;
    const data = new Uint8Array(64 * 4);
    colors.forEach((c, i) => { if (c) { const [r, g, b] = hexToRgb(c); data.set([r, g, b, 255], i * 4); } });
    gl.bindTexture(gl.TEXTURE_2D, this.palette);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.texParams(gl, false);
  }
  /** 持ち主テクスチャ: R=持ち主, G=128 なら最近占領されたマス */
  attachGame(game, me) {
    this.game = game; this.me = me;
    this.dirty.clear();
    const { gl, map } = this;
    const { N, W, H } = map;
    const data = new Uint8Array(N * 4);
    for (let i = 0; i < N; i++) this.computeTexel(i, data, i * 4);
    gl.bindTexture(gl.TEXTURE_2D, this.ownerTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.texParams(gl, false);
  }
  computeTexel(i, out, o) {
    const g = this.game, map = this.map;
    out[o] = g ? g.owner[i] : map.initPref[i];
    out[o + 1] = g && g.isRecent(i) ? 128 : 0;
    out[o + 2] = 0;
    out[o + 3] = 0;
  }
  cellChanged(i) { this.dirty.add(i); }
  flush() {
    if (!this.dirty.size) return;
    const { gl, map } = this;
    if (this.dirty.size > 20000) { const g = this.game; this.dirty.clear(); this.attachGame(g, this.me); return; }
    gl.bindTexture(gl.TEXTURE_2D, this.ownerTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const i of this.dirty) {
      this.computeTexel(i, this.texel, 0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, i % map.W, (i / map.W) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.texel);
    }
    this.dirty.clear();
  }
  buildGround() {
    const gl = this.gl, { W, H } = this.map;
    const m = 6000;
    const v = new Float32Array([-m, -m, W + m, -m, -m, H + m, W + m, H + m]);
    this.groundBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.groundBuf);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
  }
  /** 連絡線（橋・トンネル・航路）とインセット枠 */
  buildLines() {
    const gl = this.gl, map = this.map;
    const verts = [];
    this.lineGroups = {};
    const pushSeg = (ax, ay, bx, by, d0, d1) => {
      const q = [[-1, 0, d0], [1, 0, d0], [-1, 1, d1], [1, 0, d0], [1, 1, d1], [-1, 1, d1]];
      for (const [side, end, d] of q) verts.push(ax, ay, bx, by, side, end, d);
    };
    const group = (name, fn) => { const start = verts.length / 7; fn(); this.lineGroups[name] = [start, verts.length / 7 - start]; };
    const polyline = (pts) => {
      let d = 0;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const L = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
        pushSeg(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], d, d + L);
        d += L;
      }
    };
    const W = map.W;
    const c = (i) => [(i % W) + 0.5, ((i / W) | 0) + 0.5];
    this.linkStubs = [];
    group('links', () => {
      for (const l of map.raw.links) {
        const [ax, ay] = c(l.a), [bx, by] = c(l.b);
        const L = Math.hypot(bx - ax, by - ay);
        if (l.stub) {
          const ux = (bx - ax) / L, uy = (by - ay) / L, s = 45;
          pushSeg(ax, ay, ax + ux * s, ay + uy * s, 0, s);
          pushSeg(bx, by, bx - ux * s, by - uy * s, 0, s);
          this.linkStubs.push({ x: ax + ux * s, y: ay + uy * s, name: l.name });
          this.linkStubs.push({ x: bx - ux * s, y: by - uy * s, name: l.name });
        } else pushSeg(ax, ay, bx, by, 0, L);
      }
    });
    group('inset', () => { for (const r of map.raw.insets) polyline(r.poly); });
    this.lineBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  }
  resize(w, h, dpr) {
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
  }
  /** opt: { fill, place, time, meshes: { box|roof|cone|cyl: {data, count} } } */
  render(cam, opt) {
    const gl = this.gl, map = this.map;
    this.flush();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.09, 0.25, 0.40, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const vp = cam.compute();
    // --- 地面
    const g = this.ground;
    gl.useProgram(g.p);
    gl.disable(gl.DEPTH_TEST);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.groundBuf);
    gl.enableVertexAttribArray(g.a.aPos);
    gl.vertexAttribPointer(g.a.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(g.u.uVP, false, vp);
    const tex = [[this.terrainTex, 'uTerrain'], [this.elevTex, 'uElev'], [this.ownerTex, 'uOwner'], [this.palette, 'uPalette']];
    tex.forEach(([t, name], k) => { gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(g.u[name], k); });
    gl.uniform2f(g.u.uGrid, map.W, map.H);
    gl.uniform1f(g.u.uFill, opt.fill);
    gl.uniform1f(g.u.uMe, this.me);
    gl.uniform1f(g.u.uPlace, opt.place ? 1 : 0);
    gl.uniform1f(g.u.uTime, opt.time || 0);
    if (g.u.uCpp) gl.uniform1f(g.u.uCpp, 1 / cam.cellPx());
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(g.a.aPos);
    // --- 連絡線・インセット枠
    const L = this.line, cpp = 1 / cam.cellPx();
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
    draw('links', 3.0, [0.25, 0.15, 0.05, 0.6], 12);
    draw('links', 1.8, [1, 0.88, 0.45, 1], 12);
    draw('inset', 1.5, [1, 1, 1, 0.5], 10);
    for (const k of ['aA', 'aB', 'aInfo']) gl.disableVertexAttribArray(L.a[k]);
    gl.disable(gl.BLEND);
    // --- 建物・兵士・木（インスタンス描画）
    const meshes = opt.meshes;
    if (meshes) {
      const M = this.mesh, ext = this.instExt;
      gl.useProgram(M.p);
      gl.enable(gl.DEPTH_TEST);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(M.u.uVP, false, vp);
      const attrs = [[M.a.iOff, 3, 0], [M.a.iScale, 3, 12], [M.a.iColor, 4, 24]];
      for (const [name, inst] of Object.entries(meshes)) {
        if (!inst || !inst.count) continue;
        const mb = this.meshBufs[name];
        gl.bindBuffer(gl.ARRAY_BUFFER, mb.buf);
        gl.enableVertexAttribArray(M.a.aPos); gl.enableVertexAttribArray(M.a.aNrm);
        gl.vertexAttribPointer(M.a.aPos, 3, gl.FLOAT, false, 24, 0);
        gl.vertexAttribPointer(M.a.aNrm, 3, gl.FLOAT, false, 24, 12);
        if (ext) {
          gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
          gl.bufferData(gl.ARRAY_BUFFER, inst.data.subarray(0, inst.count * INST_FLOATS), gl.DYNAMIC_DRAW);
          for (const [a, n, off] of attrs) {
            gl.enableVertexAttribArray(a);
            gl.vertexAttribPointer(a, n, gl.FLOAT, false, INST_FLOATS * 4, off);
            ext.vertexAttribDivisorANGLE(a, 1);
          }
          ext.drawArraysInstancedANGLE(gl.TRIANGLES, 0, mb.count, inst.count);
          for (const [a] of attrs) { ext.vertexAttribDivisorANGLE(a, 0); gl.disableVertexAttribArray(a); }
        } else {
          const d = inst.data;
          for (let k = 0; k < inst.count; k++) {
            const o = k * INST_FLOATS;
            gl.vertexAttrib3f(attrs[0][0], d[o], d[o + 1], d[o + 2]);
            gl.vertexAttrib3f(attrs[1][0], d[o + 3], d[o + 4], d[o + 5]);
            gl.vertexAttrib4f(attrs[2][0], d[o + 6], d[o + 7], d[o + 8], d[o + 9]);
            gl.drawArrays(gl.TRIANGLES, 0, mb.count);
          }
        }
        gl.disableVertexAttribArray(M.a.aPos); gl.disableVertexAttribArray(M.a.aNrm);
      }
      gl.disable(gl.DEPTH_TEST);
    }
  }
}

/** インスタンスを貯めるバッファ（メッシュごと） */
class InstanceList {
  constructor() { this.data = new Float32Array(INST_FLOATS * 1024); this.count = 0; }
  clear() { this.count = 0; }
  push(x, y, z, sx, sy, sz, c, rot) {
    if ((this.count + 1) * INST_FLOATS > this.data.length) {
      const d = new Float32Array(this.data.length * 2); d.set(this.data); this.data = d;
    }
    const o = this.count * INST_FLOATS, d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = sx; d[o + 4] = sy; d[o + 5] = sz;
    d[o + 6] = c[0]; d[o + 7] = c[1]; d[o + 8] = c[2]; d[o + 9] = rot || 0;
    this.count++;
  }
}
