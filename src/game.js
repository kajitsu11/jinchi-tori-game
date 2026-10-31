'use strict';
/* 47都道府県対抗 陣取り合戦  — 単一HTML版
 * 構成: CONFIG / ユーティリティ / マップデータ / カメラ / WebGL描画 / ゲームルール(AI含む) / UI / 入力 / アプリ(ステートマシン)
 */
(() => {

// =====================================================================
// CONFIG（調整値）
// =====================================================================
const CONFIG = {
  DAY_SECONDS: 90,            // 1日の長さ（秒）
  WIN_RATIO: 0.5,             // 勝利に必要な全国陸地の割合
  PARTICIPANTS_PER_MILLION: 6,// 人口100万人あたりの参加者数
  MIN_PARTICIPANTS: 3,        // 1県あたり最低参加者数
  ATTACK_SUCCESS: 0.85,       // 攻撃の基本成功率（防御・当日変更済みのマスは必ず失敗）
  AI_DEFENDER_RATIO: 0.18,    // AIのうち「防御担当」の割合
  AI_IDLE_RATE: 0.04,         // AIがその日何もしない確率
  AI_CANDIDATES: 6,           // AIが比較する県境マスの候補数
  AI_YESTERDAY_WEIGHT: 1.6,   // 前日に動いた場所の近くを重視する度合い
  AI_CAPITAL_WEIGHT: 1.3,     // 県庁マスの近くを重視する度合い
  AI_NEAR_RADIUS: 12,         // 前日の場所の近くを探す半径（マス）
  CAMERA_PITCH: 55,           // 斜め見下ろしの角度（度）
  TOP_PITCH: 90,              // 真上ビュー
  TITLE_PITCH: 72,            // タイトル画面の背景
  FOV: 45,
  ZOOM_MIN: 5,                // カメラ距離（マス単位）
  ZOOM_MAX: 6500,
  OWNER_MIX: 0.52,            // 地形に対する県色の濃さ
  OWNER_MIX_TOP: 0.88,        // 真上ビューの県色の濃さ
  BLINK_HZ: 1.4,
  LOG_MAX: 4,
  BANNER_MS: 1800,
  MINIMAP_REFRESH: 1.0,       // ミニマップ再描画間隔（秒）
  MAX_DPR: 2,
};

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
    this.tx = clamp(this.tx, x0 - 100, x1 + 100);
    this.tz = clamp(this.tz, z0 - 100, z1 + 100);
    this.dist = clamp(this.dist, CONFIG.ZOOM_MIN, CONFIG.ZOOM_MAX);
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
float isMe(vec2 c){ return 1.0 - step(0.5, abs(ownerAt(c) - uMe)); }
void main(){
  vec3 sea = vec3(0.12, 0.24, 0.39);
  vec2 cell = floor(vWorld);
#ifdef HAS_DERIV
  vec2 fw = fwidth(vWorld);
  float cpp = max(max(fw.x, fw.y), 1e-4);
#else
  float cpp = uCpp;
#endif
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= uGrid.x || cell.y >= uGrid.y) { gl_FragColor = vec4(sea * 0.92, 1.0); return; }
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
    // その日に持ち主が変わったマス：斜線
    if (o.g > 0.5) {
      float s = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 10.0));
      col = mix(col, vec3(1.0), s * 0.45);
    }
    // 防御中のマス
    if (o.b > 0.5) col = mix(col, vec3(0.78, 0.96, 1.0), 0.42);
    // 攻撃できるマス：赤く点滅
    if (uBlink > 0.0 && abs(id - uMe) > 0.5 && o.g < 0.5 && o.b < 0.5) {
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

const BOX_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
uniform mat4 uVP;
uniform vec3 uOff;
uniform vec3 uScale;
varying vec3 vN;
void main(){ vN = aNrm; gl_Position = uVP * vec4(aPos * uScale + uOff, 1.0); }`;
const BOX_FS = `
precision mediump float;
uniform vec3 uColor;
varying vec3 vN;
void main(){
  float l = 0.45 + 0.55 * max(dot(normalize(vN), normalize(vec3(-0.35, 0.85, 0.45))), 0.0);
  gl_FragColor = vec4(uColor * l, 1.0);
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
    this.ground = compile(gl, GROUND_VS, GROUND_FS, deriv ? '#define HAS_DERIV\n' : '');
    this.line = compile(gl, LINE_VS, LINE_FS);
    this.box = compile(gl, BOX_VS, BOX_FS);
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
    for (const b of [this.groundBuf, this.lineBuf, this.boxBuf]) gl.deleteBuffer(b);
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
  computeTexel(i, out, o) {
    const g = this.game, map = this.map;
    const own = g ? g.owner[i] : map.initPref[i];
    out[o] = own;
    out[o + 1] = g && g.dayChanged[i] === g.day ? 255 : 0;
    out[o + 2] = g && g.defendedDay[i] === g.day ? 255 : 0;
    let a = 0;
    if (g && this.me && own && own !== this.me) {
      const ls = map.linkMap.get(i);
      if (ls) for (const j of ls) if (g.owner[j] === this.me) { a = 255; break; }
    }
    out[o + 3] = a;
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
        if (L > 160) {
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
      for (const r of map.raw.insets) {
        polyline([r.x0, r.y0, r.x1, r.y0, r.x1, r.y1, r.x0, r.y1, r.x0, r.y0]);
      }
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
    gl.clearColor(0.11, 0.22, 0.36, 1);
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
    // --- 県庁の建物
    const B = this.box;
    gl.useProgram(B.p);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxBuf);
    gl.enableVertexAttribArray(B.a.aPos); gl.enableVertexAttribArray(B.a.aNrm);
    gl.vertexAttribPointer(B.a.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(B.a.aNrm, 3, gl.FLOAT, false, 24, 12);
    gl.uniformMatrix4fv(B.u.uVP, false, vp);
    const s = clamp(cam.dist * 0.0075, 0.9, 40);
    for (let p = 1; p <= 47; p++) {
      const c = map.capitalCell[p];
      const x = (c % map.W) + 0.5, z = ((c / map.W) | 0) + 0.5;
      const own = this.game ? this.game.owner[c] : p;
      const col = hexToRgb(map.prefs[own].color);
      // 土台（白）
      gl.uniform3f(B.u.uOff, x, 0, z); gl.uniform3f(B.u.uScale, s * 1.6, s * 0.5, s * 1.2); gl.uniform3f(B.u.uColor, 0.92, 0.92, 0.9);
      gl.drawArrays(gl.TRIANGLES, 0, this.boxCount);
      // 塔（持ち主の色）
      gl.uniform3f(B.u.uOff, x, s * 0.5, z); gl.uniform3f(B.u.uScale, s * 0.7, s * 1.5, s * 0.7);
      gl.uniform3f(B.u.uColor, col[0] / 255, col[1] / 255, col[2] / 255);
      gl.drawArrays(gl.TRIANGLES, 0, this.boxCount);
      // 屋根
      gl.uniform3f(B.u.uOff, x, s * 2.0, z); gl.uniform3f(B.u.uScale, s * 0.95, s * 0.18, s * 0.95); gl.uniform3f(B.u.uColor, 0.25, 0.25, 0.3);
      gl.drawArrays(gl.TRIANGLES, 0, this.boxCount);
    }
    gl.disableVertexAttribArray(B.a.aPos); gl.disableVertexAttribArray(B.a.aNrm);
    gl.disable(gl.DEPTH_TEST);
  }
}

// =====================================================================
// ゲームルール
// =====================================================================
class Game {
  constructor(map, me, seed) {
    this.map = map;
    this.me = me;
    this.rng = mulberry32(seed);
    const N = map.N;
    this.owner = map.initPref.slice();
    this.counts = Int32Array.from(map.initCounts);
    this.dayChanged = new Uint16Array(N);
    this.defendedDay = new Uint16Array(N);
    this.day = 1;
    this.time = 0;
    this.listeners = {};
    this.eliminated = new Set();
    this.over = null;
    // 8方向の近傍オフセット
    const W = map.W;
    this.offs = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];
    // 参加者（プレイヤー1人＋AI）
    this.participants = [];
    for (let p = 1; p <= 47; p++) {
      const n = this.participantCount(p);
      for (let k = 0; k < n; k++) {
        const isPlayer = p === me && k === 0;
        this.participants.push({ pref: p, player: isPlayer,
          role: !isPlayer && this.rng() < CONFIG.AI_DEFENDER_RATIO ? 'def' : 'atk', time: 0 });
      }
    }
    this.player = { acted: false, result: null };
    this.buildFrontier();
    this.yesterday = Array.from({ length: 48 }, () => []);
    this.history = [];
    this.lastReport = null;
    this.startDay();
  }
  participantCount(p) {
    return Math.max(CONFIG.MIN_PARTICIPANTS, Math.round(this.map.prefs[p].pop / 100 * CONFIG.PARTICIPANTS_PER_MILLION));
  }
  on(ev, fn) { (this.listeners[ev] || (this.listeners[ev] = [])).push(fn); }
  emit(ev, ...a) { const l = this.listeners[ev]; if (l) for (const f of l) f(...a); }
  dispose() { this.listeners = {}; this.queue = []; }

  // ---- 隣接
  forNeighbors(i, fn) {
    const ip = this.map.initPref;
    for (const o of this.offs) { const j = i + o; if (ip[j]) fn(j); }
    const ls = this.map.linkMap.get(i);
    if (ls) for (const j of ls) fn(j);
  }
  isFrontierCell(i) {
    const o = this.owner[i], ip = this.map.initPref, ow = this.owner;
    for (const off of this.offs) { const j = i + off; if (ip[j] && ow[j] !== o) return true; }
    const ls = this.map.linkMap.get(i);
    if (ls) for (const j of ls) if (ow[j] !== o) return true;
    return false;
  }
  adjacentTo(t, P) {
    const ow = this.owner;
    for (const off of this.offs) if (ow[t + off] === P) return true;
    const ls = this.map.linkMap.get(t);
    if (ls) for (const j of ls) if (ow[j] === P) return true;
    return false;
  }
  // ---- 県境リスト（各県の、他県に接している自マス）
  buildFrontier() {
    const N = this.map.N, ip = this.map.initPref;
    this.frontierPos = new Int32Array(N).fill(-1);
    this.frontier = Array.from({ length: 48 }, () => []);
    for (let i = 0; i < N; i++) if (ip[i] && this.isFrontierCell(i)) this.addFrontier(i);
  }
  addFrontier(i) {
    const arr = this.frontier[this.owner[i]];
    this.frontierPos[i] = arr.length;
    arr.push(i);
  }
  removeFrontier(i, listOwner) {
    const pos = this.frontierPos[i];
    if (pos < 0) return;
    const arr = this.frontier[listOwner];
    const last = arr.pop();
    if (last !== i) { arr[pos] = last; this.frontierPos[last] = pos; }
    this.frontierPos[i] = -1;
  }
  refreshFrontier(k) {
    const want = this.isFrontierCell(k), has = this.frontierPos[k] >= 0;
    if (want && !has) this.addFrontier(k);
    else if (!want && has) this.removeFrontier(k, this.owner[k]);
  }
  setOwner(i, P) {
    const old = this.owner[i];
    this.removeFrontier(i, old);
    this.owner[i] = P;
    this.counts[old]--; this.counts[P]++;
    this.dayChanged[i] = this.day;
    this.refreshFrontier(i);
    this.forNeighbors(i, (j) => this.refreshFrontier(j));
    this.emit('cell', i);
  }

  // ---- 1日の進行
  startDay() {
    this.time = 0;
    this.player.acted = false;
    this.player.result = null;
    this.today = { gains: new Int32Array(48), losses: new Int32Array(48), captures: 0,
      events: Array.from({ length: 48 }, () => []), defends: 0, eliminated: [] };
    this.changedToday = [];
    this.defendedToday = [];
    this.queue = [];
    for (const a of this.participants) {
      if (a.player || this.counts[a.pref] === 0) continue;
      if (this.rng() < CONFIG.AI_IDLE_RATE) continue;
      a.time = 0.3 + this.rng() * (CONFIG.DAY_SECONDS - 0.6);
      this.queue.push(a);
    }
    this.queue.sort((a, b) => a.time - b.time);
    this.qi = 0;
    this.emit('day', this.day);
  }
  update(dt) {
    if (this.over) return;
    this.time = Math.min(CONFIG.DAY_SECONDS, this.time + dt);
    while (this.qi < this.queue.length && this.queue[this.qi].time <= this.time && !this.over) {
      this.runAI(this.queue[this.qi++]);
    }
  }
  get timeUp() { return this.time >= CONFIG.DAY_SECONDS; }
  /** 「次の日へ」：残りの行動を全部処理して日報を作る */
  finishDay() {
    while (this.qi < this.queue.length && !this.over) this.runAI(this.queue[this.qi++]);
    this.time = CONFIG.DAY_SECONDS;
    const report = this.makeReport();
    this.lastReport = report;
    this.history.push({ day: this.day, cells: this.counts[this.me] });
    return report;
  }
  nextDay() {
    // 前日の動きを記録（AIが重視する）
    this.yesterday = this.today.events.map((e) => e.slice());
    const clearList = this.changedToday.concat(this.defendedToday);
    this.day++;
    this.startDay();
    for (const i of clearList) this.emit('flag', i);
  }
  ranking() {
    const arr = [];
    for (let p = 1; p <= 47; p++) arr.push(p);
    arr.sort((a, b) => this.counts[b] - this.counts[a] || a - b);
    return arr;
  }
  rankOf(p) { return this.ranking().indexOf(p) + 1; }
  makeReport() {
    const t = this.today, me = this.me;
    const top = [];
    for (let p = 1; p <= 47; p++) if (t.gains[p] > 0) top.push(p);
    top.sort((a, b) => t.gains[b] - t.gains[a]);
    return {
      day: this.day, action: this.player.result, gains: t.gains[me], losses: t.losses[me],
      cells: this.counts[me], delta: this.counts[me] - this.map.initCounts[me], rank: this.rankOf(me),
      captures: t.captures, defends: t.defends,
      top: top.slice(0, 5).map((p) => ({ p, gains: t.gains[p], losses: t.losses[p] })),
      eliminated: t.eliminated.slice(),
    };
  }

  // ---- 行動
  canAttack(P, t) {
    const ow = this.owner;
    if (!this.map.initPref[t]) return 'sea';
    if (ow[t] === P) return 'own';
    if (!this.adjacentTo(t, P)) return 'far';
    if (this.dayChanged[t] === this.day) return 'changed';
    if (this.defendedDay[t] === this.day) return 'defended';
    return null;
  }
  canDefend(P, t) {
    if (!this.map.initPref[t]) return 'sea';
    if (this.owner[t] !== P) return 'notown';
    if (this.defendedDay[t] === this.day) return 'already';
    return null;
  }
  attack(P, t, byPlayer) {
    const why = this.canAttack(P, t);
    if (why) return { ok: false, why };
    if (this.rng() > CONFIG.ATTACK_SUCCESS) return { ok: false, why: 'repelled' };
    const old = this.owner[t];
    this.setOwner(t, P);
    this.changedToday.push(t);
    const T = this.today;
    T.gains[P]++; T.losses[old]++; T.captures++;
    this.pushEvent(T.events[P], t); this.pushEvent(T.events[old], t);
    const capital = this.map.capitalOf.get(t);
    this.emit('capture', { cell: t, by: P, from: old, byPlayer, capital });
    if (this.counts[old] === 0) {
      this.eliminated.add(old);
      T.eliminated.push(old);
      this.emit('eliminated', old);
    }
    this.checkEnd();
    return { ok: true, from: old };
  }
  defend(P, t, byPlayer) {
    const why = this.canDefend(P, t);
    if (why) return { ok: false, why };
    this.defendedDay[t] = this.day;
    this.defendedToday.push(t);
    this.today.defends++;
    this.emit('flag', t);
    this.emit('defend', { cell: t, by: P, byPlayer });
    return { ok: true };
  }
  pushEvent(arr, t) {
    if (arr.length < 200) arr.push(t);
    else arr[(this.rng() * 200) | 0] = t;
  }
  playerAct(type, t) {
    if (this.player.acted || this.over) return null;
    const pre = type === 'attack' ? this.canAttack(this.me, t) : this.canDefend(this.me, t);
    // 届かないマスなどは行動を消費しない
    if (pre && pre !== 'defended') return { ok: false, why: pre, consumed: false };
    const from = this.owner[t];
    const r = type === 'attack' ? this.attack(this.me, t, true) : this.defend(this.me, t, true);
    this.player.acted = true;
    this.player.result = { type, cell: t, ok: r.ok, why: r.why, from };
    this.emit('player', this.player.result);
    return { ...r, consumed: true };
  }
  checkEnd() {
    if (this.over) return;
    const need = this.map.landCells * CONFIG.WIN_RATIO;
    if (this.counts[this.me] === 0) { this.over = { win: false, reason: 'lost' }; }
    else if (this.counts[this.me] >= need) { this.over = { win: true, reason: 'majority' }; }
    else {
      for (let p = 1; p <= 47; p++) {
        if (p !== this.me && this.counts[p] >= need) { this.over = { win: false, reason: 'rival', rival: p }; break; }
      }
    }
    if (this.over) { this.over.day = this.day; this.emit('over', this.over); }
  }

  // ---- AI
  runAI(a) {
    const P = a.pref;
    if (this.counts[P] === 0 || !this.frontier[P].length) return;
    if (a.role === 'def') this.aiDefend(P); else this.aiAttack(P);
  }
  dist(a, b) {
    const W = this.map.W;
    const dx = (a % W) - (b % W), dy = ((a / W) | 0) - ((b / W) | 0);
    return Math.sqrt(dx * dx + dy * dy);
  }
  /** 前日の出来事の近くにある自県の県境マスを探す */
  nearFrontier(P, center) {
    const W = this.map.W, R = CONFIG.AI_NEAR_RADIUS;
    const cx = center % W, cy = (center / W) | 0;
    for (let r = 0; r <= R; r++) {
      for (let k = 0; k < 6; k++) {
        const x = cx + Math.round((this.rng() * 2 - 1) * r), y = cy + Math.round((this.rng() * 2 - 1) * r);
        const i = y * W + x;
        if (i >= 0 && i < this.map.N && this.frontierPos[i] >= 0 && this.owner[i] === P) return i;
      }
    }
    return -1;
  }
  proximity(f, list, scale) {
    if (!list || !list.length) return 0;
    let best = 1e9;
    const n = Math.min(list.length, 16);
    for (let k = 0; k < n; k++) {
      const c = list[(this.rng() * list.length) | 0];
      const d = this.dist(f, c);
      if (d < best) best = d;
    }
    return Math.exp(-best / scale);
  }
  enemyCapitalProx(f, P) {
    let best = 1e9;
    for (let q = 1; q <= 47; q++) {
      const c = this.map.capitalCell[q];
      if (this.owner[c] === P) continue;
      const d = this.dist(f, c);
      if (d < best) best = d;
    }
    // 自県の県庁が奪われていたら取り返したい
    const own = this.map.capitalCell[P];
    if (this.owner[own] !== P) best = Math.min(best, this.dist(f, own) * 0.5);
    return Math.exp(-best / 80);
  }
  pickFrontier(P, events, scoreFn) {
    const fr = this.frontier[P];
    let best = -1, bestS = -1e9;
    for (let k = 0; k < CONFIG.AI_CANDIDATES; k++) {
      let f = -1;
      if (events.length && this.rng() < 0.5) f = this.nearFrontier(P, events[(this.rng() * events.length) | 0]);
      if (f < 0) f = fr[(this.rng() * fr.length) | 0];
      const s = this.rng() + scoreFn(f);
      if (s > bestS) { bestS = s; best = f; }
    }
    return best;
  }
  aiAttack(P) {
    const ev = this.yesterday[P];
    for (let tries = 0; tries < 4; tries++) {
      const f = this.pickFrontier(P, ev, (f) =>
        CONFIG.AI_YESTERDAY_WEIGHT * this.proximity(f, ev, 20) + CONFIG.AI_CAPITAL_WEIGHT * this.enemyCapitalProx(f, P));
      if (f < 0) return;
      const cands = [];
      let capTarget = -1;
      this.forNeighbors(f, (j) => {
        if (this.owner[j] !== P && !this.canAttack(P, j)) {
          cands.push(j);
          if (this.map.capitalOf.has(j)) capTarget = j;
        }
      });
      if (!cands.length) continue;
      const t = capTarget >= 0 ? capTarget : cands[(this.rng() * cands.length) | 0];
      this.attack(P, t, false);
      return;
    }
  }
  aiDefend(P) {
    const ev = this.yesterday[P];
    const cap = this.map.capitalCell[P];
    // 県庁が県境にあって未防御なら最優先
    if (this.owner[cap] === P && this.frontierPos[cap] >= 0 && this.defendedDay[cap] !== this.day && this.rng() < 0.8) {
      this.defend(P, cap, false);
      return;
    }
    for (let tries = 0; tries < 4; tries++) {
      const f = this.pickFrontier(P, ev, (f) =>
        CONFIG.AI_YESTERDAY_WEIGHT * this.proximity(f, ev, 20) + 1.2 * Math.exp(-this.dist(f, cap) / 40));
      if (f < 0) return;
      if (this.defendedDay[f] === this.day) continue;
      this.defend(P, f, false);
      return;
    }
  }
}

// =====================================================================
// アプリ本体（ステートマシン）
// =====================================================================
const STATE = { LOADING: 'LOADING', TITLE: 'TITLE', PLAYING: 'PLAYING', GAMEOVER: 'GAMEOVER' };

const App = {
  state: null,
  stateCtrl: null,     // ステートごとのイベントを片付ける AbortController
  map: null, renderer: null, cam: new Camera(), game: null,
  me: 0, titleSel: 0, topView: false, sel: -1, paused: false,
  lastT: 0, clock: 0, minimapT: 0, minimapDirty: true,
  dpr: 1, w: 1, h: 1,
  bannerTimer: 0,

  setState(s, arg) {
    if (this.stateCtrl) this.stateCtrl.abort();
    this.stateCtrl = new AbortController();
    const prev = this.state;
    this.state = s;
    document.body.dataset.state = s;
    const enter = this['enter' + s];
    if (enter) enter.call(this, this.stateCtrl.signal, arg, prev);
  },

  // ------------------------------------------------ LOADING
  async enterLOADING() {
    const bar = $('loadbar'), msg = $('loadmsg');
    const progress = (p, m) => { bar.style.width = (p * 100).toFixed(0) + '%'; if (m) msg.textContent = m; };
    try {
      progress(0.02, 'マップデータを読み込み中…');
      await nextFrame();
      const raw = JSON.parse($('mapdata').textContent);
      $('mapdata').remove();   // 大きな文字列はもう不要
      this.map = new MapData(raw);
      await this.map.decode(progress);
      progress(0.5, '3D描画を準備中…'); await nextFrame();
      this.renderer = new Renderer($('gl'), this.map);
      this.cam.bounds = [0, 0, this.map.W, this.map.H];
      this.renderer.setPalette(this.map.prefs.map((p) => (p ? p.color : null)));
      progress(0.65, '地形テクスチャを作成中…'); await nextFrame();
      this.renderer.uploadTerrain();
      progress(0.85, '領土テクスチャを作成中…'); await nextFrame();
      this.renderer.attachGame(null, 0);
      progress(1, '準備完了');
      this.setupInput();
      this.resize();
      this.resetCamera(true);
      this.buildTitleList();
      await nextFrame();
      $('loading').classList.add('hidden');
      this.setState(STATE.TITLE);
    } catch (e) {
      console.error(e);
      msg.textContent = 'エラー: ' + e.message;
      bar.style.background = '#ff4a3d';
      window.__jinchiError = e.message;
    }
  },

  // ------------------------------------------------ TITLE
  enterTITLE(signal) {
    if (this.game) { this.game.dispose(); this.game = null; }
    this.renderer.attachGame(null, 0);
    this.topView = false; this.cam.pitchGoal = CONFIG.TITLE_PITCH;
    this.sel = -1; this.paused = false;
    this.closeModal();
    $('title').classList.remove('hidden');
    $('hud').classList.add('hidden');
    $('t-cells').textContent = Math.round(this.map.landCells / 10000) + '万';
    this.resetCamera(false);
    $('pref-list').addEventListener('click', (e) => {
      const b = e.target.closest('.pbtn');
      if (b) this.selectTitlePref(+b.dataset.p, true);
    }, { signal });
    $('btn-start').addEventListener('click', () => {
      if (this.titleSel) this.startGame(this.titleSel);
    }, { signal });
    signal.addEventListener('abort', () => $('title').classList.add('hidden'));
    if (this.titleSel) this.selectTitlePref(this.titleSel, false);
  },
  buildTitleList() {
    const regions = {};
    for (const p of this.map.prefs) if (p) (regions[p.area] || (regions[p.area] = [])).push(p);
    let html = '';
    for (const [area, list] of Object.entries(regions)) {
      html += `<div class="region"><h3>${area}</h3><div class="prefs">`;
      for (const p of list) html += `<button class="pbtn" data-p="${p.id}"><span class="chip" style="background:${p.color}"></span>${escapeHtml(p.short)}</button>`;
      html += '</div></div>';
    }
    $('pref-list').innerHTML = html;
  },
  selectTitlePref(p, fly) {
    this.titleSel = p;
    const pr = this.map.prefs[p];
    for (const b of document.querySelectorAll('.pbtn')) b.classList.toggle('sel', +b.dataset.p === p);
    $('pd-chip').style.background = pr.color;
    $('pd-name').textContent = pr.name;
    const n = Math.max(CONFIG.MIN_PARTICIPANTS, Math.round(pr.pop / 100 * CONFIG.PARTICIPANTS_PER_MILLION));
    $('pd-sub').textContent = `人口${fmt(Math.round(pr.pop))}万人・参加者${n}人（あなた＋AI${n - 1}人）・${fmt(this.map.initCounts[p])}マス`;
    $('btn-start').disabled = false;
    const b = document.querySelector(`.pbtn[data-p="${p}"]`);
    if (b && fly) b.scrollIntoView({ block: 'nearest' });
    if (fly) this.flyToPref(p, 700, 0.3);
  },
  flyToPref(p, dist, anchorY) {
    const c = this.map.capitalCell[p];
    this.cam.flyTo((c % this.map.W) + 0.5, ((c / this.map.W) | 0) + 0.5, dist, anchorY);
  },
  resetCamera(instant) {
    const W = this.map.W, H = this.map.H;
    const aspect = this.w / this.h;
    const th = Math.tan(this.cam.fovY / 2);
    // タイトルでは下のシートに隠れないよう、画面上側に日本全体を出す
    const title = this.state === STATE.TITLE || this.state === STATE.LOADING || !this.state;
    const dist = clamp(Math.max(W * 0.85 / (2 * th * aspect), H * (title ? 1.0 : 0.62) / (2 * th)), 500, CONFIG.ZOOM_MAX);
    this.cam.flyTo(W * 0.56, H * 0.5, dist, title ? 0.3 : 0.5);
    if (instant) { const g = this.cam.goal; this.cam.tx = g.x; this.cam.tz = g.z; this.cam.dist = g.dist; this.cam.goal = null; }
  },

  // ------------------------------------------------ PLAYING
  startGame(p) {
    this.me = p;
    const seedParam = new URLSearchParams(location.search).get('seed');
    const seed = seedParam ? +seedParam : (Date.now() & 0x7fffffff);
    this.game = new Game(this.map, p, seed);
    this.renderer.attachGame(this.game, p);
    this.setState(STATE.PLAYING);
  },
  enterPLAYING(signal) {
    const g = this.game, map = this.map;
    $('hud').classList.remove('hidden');
    $('log').innerHTML = '';
    this.sel = -1; this.paused = false; this.topView = false;
    this.cam.pitchGoal = CONFIG.CAMERA_PITCH;
    $('btn-top').classList.remove('on'); $('toplabel').classList.add('hidden');
    this.hidePanel();
    const pr = map.prefs[this.me];
    $('h-chip').style.background = pr.color;
    $('h-pref').textContent = pr.name;
    this.flyToPref(this.me, 160, 0.45);
    // ゲームのイベント
    g.on('cell', (i) => { this.renderer.cellChanged(i); this.minimapDirty = true; if (i === this.sel) this.updatePanel(); });
    g.on('flag', (i) => { this.renderer.cellChanged(i); if (i === this.sel) this.updatePanel(); });
    g.on('capture', (e) => this.onCapture(e));
    g.on('eliminated', (p) => {
      if (p !== this.me) this.log(`${map.prefs[p].name}が全てのマスを失い、脱落しました`, 'bad', -1);
    });
    g.on('over', () => setTimeout(() => { if (this.state === STATE.PLAYING) this.setState(STATE.GAMEOVER); }, 900));
    // UI イベント
    $('btn-next').addEventListener('click', () => this.onNextDay(), { signal });
    $('cp-close').addEventListener('click', () => this.hidePanel(), { signal });
    $('cp-action').addEventListener('click', () => this.onAction(), { signal });
    $('sidebtns').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'rank') this.showRanking();
      else if (act === 'report') this.showReport(this.game.lastReport, false);
      else if (act === 'top') this.toggleTop();
      else if (act === 'home') this.goHome();
      else if (act === 'title') this.confirmTitle();
    }, { signal });
    $('log').addEventListener('click', (e) => {
      const d = e.target.closest('[data-cell]');
      if (d && +d.dataset.cell >= 0) this.focusCell(+d.dataset.cell, true);
    }, { signal });
    $('minimap').addEventListener('pointerdown', (e) => this.onMinimap(e), { signal });
    signal.addEventListener('abort', () => { this.hidePanel(); });
    this.updateHud(true);
    this.updateSoldier();
    this.log(`DAY 1 開始！ ${pr.name}の参加者${g.participantCount(this.me)}人で出陣`, 'good', -1);
  },
  onCapture(e) {
    const map = this.map, me = this.me;
    if (e.from === me && !e.byPlayer) {
      const what = e.capital ? `県庁（${map.prefs[me].capName}）` : 'マス';
      this.log(`⚠ 自県の${what}が${map.prefs[e.by].name}に奪われました`, 'bad', e.cell);
    } else if (e.by === me && !e.byPlayer && e.capital) {
      this.log(`味方が${map.prefs[e.capital].name}の県庁を制圧！`, 'good', e.cell);
    }
  },
  onAction() {
    const g = this.game;
    if (!g || this.sel < 0 || this.topView || this.paused) return;
    const t = this.sel;
    const type = g.owner[t] === this.me ? 'defend' : 'attack';
    const r = g.playerAct(type, t);
    if (!r) return;
    const map = this.map;
    if (!r.consumed) { this.updatePanel(); return; }
    if (type === 'attack') {
      if (r.ok) {
        const cap = map.capitalOf.get(t);
        this.banner(cap ? `${map.prefs[cap].short}県庁を制圧！` : '制圧成功！', 'ok', `${map.prefs[r.from].name}のマスを奪いました`);
        this.log(`⚔ 攻撃成功：${map.prefs[r.from].name}のマスを制圧`, 'good', t);
      } else {
        const msg = r.why === 'defended' ? '防御されていた！' : '撃退された…';
        this.banner(msg, 'ng', '攻撃は失敗しました');
        this.log(`⚔ 攻撃失敗：${msg}`, 'bad', t);
      }
    } else {
      this.banner('防御完了！', 'def', '今日いっぱい、このマスは取られません');
      this.log('🛡 防御：自県のマスを守りました', 'good', t);
    }
    this.updateSoldier();
    this.updatePanel();
    this.updateHud(true);
  },
  onNextDay() {
    if (this.paused || !this.game || this.game.over) return;
    this.hidePanel();
    const report = this.game.finishDay();
    if (this.game.over) return;      // 処理中に決着した
    this.showReport(report, true);
  },
  goHome() {
    const g = this.game, c = this.map.capitalCell[this.me];
    let target = c;
    if (g.owner[c] !== this.me) {
      const fr = g.frontier[this.me];
      if (fr.length) target = fr[(fr.length / 2) | 0];
    }
    this.cam.flyTo((target % this.map.W) + 0.5, ((target / this.map.W) | 0) + 0.5, 160, 0.45);
  },
  toggleTop() {
    this.topView = !this.topView;
    this.cam.pitchGoal = this.topView ? CONFIG.TOP_PITCH : CONFIG.CAMERA_PITCH;
    $('btn-top').classList.toggle('on', this.topView);
    $('toplabel').classList.toggle('hidden', !this.topView);
    if (this.sel >= 0) this.updatePanel();
  },
  confirmTitle() {
    this.openModal('タイトルに戻りますか？', '<p style="text-align:center">今のゲームの進行は失われます。</p>', [
      { label: 'やめる', fn: () => this.closeModal() },
      { label: 'タイトルへ', cls: 'warn', fn: () => { this.closeModal(); this.setState(STATE.TITLE); } },
    ]);
  },

  // ------------------------------------------------ GAMEOVER
  enterGAMEOVER(signal) {
    const g = this.game, map = this.map, o = g.over;
    this.hidePanel();
    let head, cls, detail;
    if (o.win) { head = '天下統一！'; cls = 'win'; detail = `${map.prefs[this.me].name}が全国の${Math.round(CONFIG.WIN_RATIO * 100)}%を支配しました。`; }
    else if (o.reason === 'rival') { head = '敗北…'; cls = 'lose'; detail = `${map.prefs[o.rival].name}が全国の${Math.round(CONFIG.WIN_RATIO * 100)}%を支配しました。`; }
    else { head = '敗北…'; cls = 'lose'; detail = `${map.prefs[this.me].name}は全てのマスを失いました。`; }
    const body = `<div class="result-big ${cls}">${head}</div><p style="text-align:center">${detail}<br>DAY ${o.day}・最終領土 ${fmt(g.counts[this.me])}マス・${g.rankOf(this.me)}位</p>`;
    this.openModal('ゲーム終了', body, [{ label: 'タイトルへ', cls: 'primary', fn: () => this.setState(STATE.TITLE) }]);
    signal.addEventListener('abort', () => { this.closeModal(); $('hud').classList.add('hidden'); });
  },

  // ------------------------------------------------ HUD / パネル
  updateHud(force) {
    const g = this.game;
    if (!g) return;
    const remain = Math.max(0, CONFIG.DAY_SECONDS - g.time);
    $('h-time').style.width = (remain / CONFIG.DAY_SECONDS * 100).toFixed(1) + '%';
    $('h-timetxt').textContent = g.timeUp ? '時間切れ' : Math.ceil(remain) + '秒';
    $('btn-next').classList.toggle('pulse', g.timeUp);
    if (!force && (this.clock % 0.25) > 0.05) return;
    $('h-day').textContent = 'DAY ' + g.day;
    const c = g.counts[this.me], d = c - this.map.initCounts[this.me];
    $('h-cells').textContent = fmt(c);
    const dEl = $('h-delta');
    dEl.textContent = `(${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmt(Math.abs(d))})`;
    dEl.className = d > 0 ? 'up' : d < 0 ? 'down' : '';
    $('h-rank').textContent = g.rankOf(this.me) + '位';
    const T = g.today;
    $('h-today').textContent = `今日 全国${fmt(T.captures)}マス制圧／自県 +${T.gains[this.me]} −${T.losses[this.me]}`;
  },
  updateSoldier() {
    const g = this.game, el = $('soldier'), r = g.player.result, map = this.map;
    el.className = '';
    if (!g.player.acted) { el.textContent = '🪖 兵士：まだ — 赤く点滅するマスを攻撃／自県のマスを防御'; return; }
    if (r.type === 'attack') {
      if (r.ok) { el.className = 'done'; el.textContent = `✅ 完了：攻撃 → 制圧成功（${map.prefs[r.from].name}のマス）`; }
      else { el.className = 'fail'; el.textContent = `✅ 完了：攻撃 → 失敗（${r.why === 'defended' ? '防御されていた' : '撃退された'}）`; }
    } else { el.className = 'done'; el.textContent = '✅ 完了：防御 → 自県のマスを守備中'; }
  },
  selectCell(i) {
    if (i < 0 || !this.map.isLand(i)) { this.hidePanel(); return; }
    this.sel = i;
    $('cellpanel').classList.remove('hidden');
    this.updatePanel();
  },
  hidePanel() { this.sel = -1; $('cellpanel').classList.add('hidden'); },
  cellName(i) {
    const map = this.map, ip = map.initPref[i], t = map.terrain[i] & 7;
    const snow = map.terrain[i] & 8 ? '（雪）' : '';
    const cap = map.capitalOf.get(i);
    if (cap) return `${map.prefs[cap].name}庁（${map.prefs[cap].capName}）`;
    const link = map.linkName.get(i);
    if (link) return `${map.prefs[ip].short}・${link}の連絡マス`;
    return `${map.prefs[ip].short}の${TERRAIN_NAMES[t]}${snow}`;
  },
  updatePanel() {
    const i = this.sel, g = this.game, map = this.map;
    if (i < 0 || !g) return;
    const own = g.owner[i], pr = map.prefs[own];
    const [x, y] = map.xy(i);
    const [lon, lat] = map.lonLat(x, y);
    $('cp-name').textContent = this.cellName(i);
    $('cp-chip').style.background = pr.color;
    $('cp-owner').textContent = '持ち主：' + pr.name + (own === this.me ? '（自県）' : '');
    let meta = `座標 (${x}, ${y})・北緯${lat.toFixed(3)}° 東経${lon.toFixed(3)}°`;
    if (map.initPref[i] !== own) meta += `・元は${map.prefs[map.initPref[i]].name}`;
    $('cp-meta').textContent = meta;
    const notes = [];
    if (g.defendedDay[i] === g.day) notes.push('🛡 今日は防御されています');
    if (g.dayChanged[i] === g.day) notes.push('／ 今日すでに持ち主が変わりました（今日はもう変わりません）');
    if (map.linkMap.has(i) && map.linkName.has(i)) notes.push('🌉 連絡マス：海の向こうのマスと隣接しています');
    const btn = $('cp-action');
    const isMine = own === this.me;
    btn.className = 'btn-action ' + (isMine ? 'def' : 'atk');
    let disabled = '', label = isMine ? '🛡 今すぐ防御する' : '⚔ 今すぐ攻撃する';
    if (this.topView) disabled = '真上ビューでは攻撃・防御できません';
    else if (g.player.acted) disabled = '今日の行動は完了しました';
    else if (isMine) {
      const why = g.canDefend(this.me, i);
      if (why === 'already') disabled = 'このマスは防御済みです';
    } else {
      const why = g.canAttack(this.me, i);
      if (why === 'far') disabled = '自県のマスに隣接していません';
      else if (why === 'changed') disabled = '今日はもう奪えません';
      else if (why === 'defended') disabled = '防御中のため攻撃できません';
    }
    btn.disabled = !!disabled;
    btn.textContent = disabled || label;
    $('cp-note').textContent = notes.join('\n');
  },
  log(text, cls, cell) {
    const box = $('log');
    // 同じ内容が続いたら「×n」でまとめる
    const first = box.firstElementChild;
    if (first && first.dataset.text === text) {
      const n = (+first.dataset.n || 1) + 1;
      first.dataset.n = n;
      first.dataset.cell = cell;
      first.textContent = `D${this.game ? this.game.day : 1} ${text} ×${n}`;
      return;
    }
    const el = document.createElement('div');
    el.dataset.text = text;
    el.className = cls || '';
    el.dataset.cell = cell;
    el.textContent = `D${this.game ? this.game.day : 1} ${text}`;
    box.prepend(el);
    // 古いログは片付ける
    while (box.children.length > CONFIG.LOG_MAX) box.lastElementChild.remove();
    Array.from(box.children).forEach((c, k) => c.classList.toggle('fade', k >= 2));
  },
  banner(text, cls, sub) {
    const b = $('banner');
    b.className = '';
    void b.offsetWidth;   // アニメーションを再始動
    b.innerHTML = escapeHtml(text) + (sub ? `<small>${escapeHtml(sub)}</small>` : '');
    b.className = 'show ' + cls;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => { b.className = ''; b.innerHTML = ''; }, CONFIG.BANNER_MS + 100);
  },
  focusCell(i, select) {
    this.cam.flyTo((i % this.map.W) + 0.5, ((i / this.map.W) | 0) + 0.5, Math.min(this.cam.dist, 80), 0.4);
    if (select && this.state === STATE.PLAYING) this.selectCell(i);
  },

  // ------------------------------------------------ モーダル
  openModal(title, body, buttons) {
    this.paused = true;
    $('m-title').textContent = title;
    $('m-body').innerHTML = body;
    const box = $('m-btns');
    box.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.cls) el.className = b.cls;
      el.onclick = b.fn;
      box.appendChild(el);
    }
    $('modal').classList.remove('hidden');
  },
  closeModal() {
    $('modal').classList.add('hidden');
    $('m-btns').innerHTML = '';   // ボタンのハンドラも破棄
    $('m-body').innerHTML = '';
    this.paused = false;
  },
  showRanking() {
    const g = this.game, map = this.map;
    const rows = g.ranking().map((p, k) => {
      const c = g.counts[p], d = c - map.initCounts[p];
      const cls = (p === this.me ? ' me' : '') + (c === 0 ? ' dead' : '');
      return `<div class="rank-row${cls}"><span class="no">${k + 1}</span><span class="chip" style="background:${map.prefs[p].color}"></span>` +
        `<span class="nm">${map.prefs[p].name}${c === 0 ? '（脱落）' : ''}</span><span class="ct">${fmt(c)}<small class="${d >= 0 ? 'plus' : 'minus'}"> ${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}</small></span>` +
        `<span class="pc">${(c / map.landCells * 100).toFixed(2)}%</span></div>`;
    }).join('');
    this.openModal(`順位（DAY ${g.day}）`, rows, [{ label: '閉じる', fn: () => this.closeModal() }]);
  },
  showReport(r, advance) {
    const map = this.map, g = this.game;
    if (!r) { this.openModal('日報', '<p style="text-align:center">まだ日報はありません。<br>「次の日へ」を押すと1日分の日報が出ます。</p>', [{ label: '閉じる', fn: () => this.closeModal() }]); return; }
    let act;
    const a = r.action;
    if (!a) act = '行動しませんでした';
    else if (a.type === 'attack') act = a.ok ? `⚔ 攻撃：<b class="plus">制圧成功</b>（${map.prefs[a.from].name}のマス）` : `⚔ 攻撃：<b class="minus">失敗</b>（${a.why === 'defended' ? '防御されていた' : '撃退された'}）`;
    else act = '🛡 防御：自県のマスを守りました';
    const net = r.gains - r.losses;
    const top = r.top.length ? r.top.map((t, k) => `<div class="rank-row"><span class="no">${k + 1}</span><span class="chip" style="background:${map.prefs[t.p].color}"></span><span class="nm">${map.prefs[t.p].name}</span><span class="ct plus">+${t.gains}</span></div>`).join('') : '<p>なし</p>';
    const elim = r.eliminated.length ? `<div class="rep-sec"><h4>脱落</h4>${r.eliminated.map((p) => map.prefs[p].name).join('、')}</div>` : '';
    const body = `
      <div class="rep-sec"><h4>あなたの兵士</h4>${act}</div>
      <div class="rep-sec"><h4>${map.prefs[this.me].name}の領土</h4>
        <span class="rep-big">${fmt(r.cells)}</span>マス　今日 <b class="plus">+${r.gains}</b> <b class="minus">−${r.losses}</b>（${net >= 0 ? '+' : '−'}${Math.abs(net)}）<br>
        開始時から ${r.delta >= 0 ? '+' : '−'}${fmt(Math.abs(r.delta))}マス・全国${r.rank}位</div>
      <div class="rep-sec"><h4>全国</h4>今日の制圧 <b>${fmt(r.captures)}</b>マス・防御 ${fmt(r.defends)}回</div>
      <div class="rep-sec"><h4>今日活躍した県</h4>${top}</div>${elim}`;
    const btns = advance
      ? [{ label: `DAY ${r.day + 1} へ ▶`, cls: 'primary', fn: () => { this.closeModal(); g.nextDay(); this.updateSoldier(); this.updateHud(true); this.log(`DAY ${g.day} 開始`, '', -1); } }]
      : [{ label: '閉じる', fn: () => this.closeModal() }];
    this.openModal(`日報 DAY ${r.day}`, body, btns);
  },

  // ------------------------------------------------ ミニマップ
  drawMinimap() {
    const cv = $('minimap'), map = this.map, g = this.game;
    const mw = 236, mh = Math.round(mw * map.H / map.W);
    if (cv.width !== mw) { cv.width = mw; cv.height = mh; this.mmImage = null; }
    const ctx = cv.getContext('2d');
    if (this.minimapDirty || !this.mmImage) {
      const img = this.mmImage || ctx.createImageData(mw, mh);
      const d = img.data, own = g ? g.owner : map.initPref;
      const cols = map.prefs.map((p) => (p ? hexToRgb(p.color) : [20, 42, 70]));
      const sx = map.W / mw, sy = map.H / mh;
      for (let y = 0; y < mh; y++) {
        for (let x = 0; x < mw; x++) {
          // 3x3 点サンプリングで小さな島も拾う
          let o = 0;
          for (let k = 0; k < 9 && !o; k++) {
            const cx = Math.floor((x + (k % 3) / 3 + 0.17) * sx), cy = Math.floor((y + ((k / 3) | 0) / 3 + 0.17) * sy);
            o = own[cy * map.W + cx];
          }
          const c = cols[o] || cols[0], q = (y * mw + x) * 4;
          d[q] = c[0]; d[q + 1] = c[1]; d[q + 2] = c[2]; d[q + 3] = 255;
        }
      }
      this.mmImage = img;
      this.minimapDirty = false;
    }
    ctx.putImageData(this.mmImage, 0, 0);
    // 表示範囲の枠
    const pts = [[0, 0], [this.w, 0], [this.w, this.h], [0, this.h]].map(([x, y]) => this.cam.groundAt(x, y));
    if (pts.every(Boolean)) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach((p, k) => { const X = p.x / map.W * mw, Y = p.z / map.H * mh; k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      ctx.closePath(); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1; ctx.stroke();
    }
  },
  onMinimap(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * this.map.W, z = (e.clientY - r.top) / r.height * this.map.H;
    this.cam.flyTo(x, z, null);
    e.preventDefault();
  },

  // ------------------------------------------------ ラベル（2Dオーバーレイ）
  drawOverlay() {
    const cv = $('overlay'), ctx = cv.getContext('2d'), map = this.map, cam = this.cam;
    const dpr = this.dpr;
    if (cv.width !== Math.round(this.w * dpr) || cv.height !== Math.round(this.h * dpr)) { cv.width = Math.round(this.w * dpr); cv.height = Math.round(this.h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const cpx = cam.cellPx();
    const v = [0, 0];
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    const fs = clamp(9 + Math.log2(cpx + 1) * 3, 9, 16);
    ctx.font = `700 ${fs}px sans-serif`;
    const bh = clamp(cam.dist * 0.0075, 0.9, 40) * 2.3;
    // 県名ラベル（重なるものは省略。自県・選択中の県・人口の多い県を優先）
    const placed = [];
    const order = [];
    for (let p = 1; p <= 47; p++) order.push(p);
    const pri = this.state === STATE.TITLE ? this.titleSel : this.me;
    order.sort((a, b) => (b === pri) - (a === pri) || map.prefs[b].pop - map.prefs[a].pop);
    for (const p of order) {
      const c = map.capitalCell[p];
      const x = (c % map.W) + 0.5, z = ((c / map.W) | 0) + 0.5;
      if (!cam.project(x, bh, z, v)) continue;
      if (v[0] < -40 || v[0] > this.w + 40 || v[1] < -10 || v[1] > this.h + 30) continue;
      const own = this.game ? this.game.owner[c] : p;
      const label = map.prefs[p].short + (cpx > 2 ? `（${map.prefs[p].capName}）` : '');
      const tw = ctx.measureText(label).width;
      const rect = [v[0] - tw / 2 - 2, v[1] - fs - 4, v[0] + tw / 2 + 2, v[1]];
      if (placed.some((q) => q[0] < rect[2] && rect[0] < q[2] && q[1] < rect[3] && rect[1] < q[3])) continue;
      placed.push(rect);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)';
      ctx.strokeText(label, v[0], v[1] - 2);
      ctx.fillStyle = own === p ? '#fff' : '#ffb3a8';
      ctx.fillText(label, v[0], v[1] - 2);
      if (p === this.me && this.state !== STATE.TITLE) { ctx.fillStyle = '#ffcf3f'; ctx.fillText('★', v[0], v[1] - fs - 2); }
      if (this.state === STATE.TITLE && p === this.titleSel) { ctx.fillStyle = '#ffcf3f'; ctx.fillText('▼', v[0], v[1] - fs - 2); }
    }
    // 連絡マスの名前
    if (cpx > 0.9) {
      ctx.font = `600 ${clamp(fs - 2, 9, 13)}px sans-serif`;
      const seen = new Set();
      for (const l of map.raw.links) {
        if (seen.has(l.name)) continue;
        const ax = (l.a % map.W), ay = (l.a / map.W) | 0, bx = (l.b % map.W), by = (l.b / map.W) | 0;
        if (Math.hypot(ax - bx, ay - by) > 160) continue;
        seen.add(l.name);
        if (!cam.project((ax + bx) / 2 + 0.5, 0, (ay + by) / 2 + 0.5, v)) continue;
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(l.name, v[0], v[1] - 4);
        ctx.fillStyle = '#ffe27a'; ctx.fillText(l.name, v[0], v[1] - 4);
      }
    }
    ctx.font = `600 11px sans-serif`;
    for (const s of this.renderer.linkStubs) {
      if (!cam.project(s.x, 0, s.y, v)) continue;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(s.name, v[0], v[1] - 3);
      ctx.fillStyle = '#ffe27a'; ctx.fillText(s.name, v[0], v[1] - 3);
    }
    // インセットの説明
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (const r of map.raw.insets) {
      if (!cam.project(r.x0 + 4, 0, r.y0 + 4, v)) continue;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(r.label, v[0], v[1]);
      ctx.fillStyle = '#fff'; ctx.fillText(r.label, v[0], v[1]);
    }
    // 選択中のマス（引きのときはマスが小さいので丸で示す）
    if (this.sel >= 0 && cpx < 6) {
      const x = (this.sel % map.W) + 0.5, z = ((this.sel / map.W) | 0) + 0.5;
      if (cam.project(x, 0, z, v)) {
        ctx.strokeStyle = '#ffe14d'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(v[0], v[1], 9, 0, Math.PI * 2); ctx.stroke();
      }
    }
  },

  // ------------------------------------------------ 入力
  setupInput() {
    const cv = $('gl');
    const ptrs = new Map();
    let tap = null, pinch = null;
    const pos = (e) => [e.clientX, e.clientY];
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, pos(e));
      if (ptrs.size === 1) tap = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
      else { tap = null; pinch = null; }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      const prev = ptrs.get(e.pointerId), cur = pos(e);
      if (ptrs.size === 1) {
        if (tap && Math.hypot(cur[0] - tap.x, cur[1] - tap.y) > 8) tap.moved = true;
        if (!tap || tap.moved) this.cam.panBy(prev[0], prev[1], cur[0], cur[1]);
      } else if (ptrs.size === 2) {
        const ids = [...ptrs.keys()];
        const other = ptrs.get(ids[0] === e.pointerId ? ids[1] : ids[0]);
        const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
        const d1 = Math.hypot(cur[0] - other[0], cur[1] - other[1]);
        const m0 = [(prev[0] + other[0]) / 2, (prev[1] + other[1]) / 2], m1 = [(cur[0] + other[0]) / 2, (cur[1] + other[1]) / 2];
        if (d1 > 10 && d0 > 10) this.cam.zoomAt(m1[0], m1[1], d0 / d1);
        this.cam.panBy(m0[0], m0[1], m1[0], m1[1]);
      }
      ptrs.set(e.pointerId, cur);
    });
    const up = (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (tap && !tap.moved && performance.now() - tap.t < 500 && e.type === 'pointerup') this.onTap(e.clientX, e.clientY);
      tap = null; pinch = null;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 0.05 : 0.0015;
      this.cam.zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * k));
    }, { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    this.keys = new Set();
    window.addEventListener('keyup', (e) => this.keys.delete(e.key));
  },
  onKey(e) {
    if (e.target && e.target.tagName === 'INPUT') return;
    this.keys.add(e.key);
    const k = e.key;
    if (k === '+' || k === '=' || k === ';') this.cam.zoomAt(this.w / 2, this.h / 2, 0.8);
    else if (k === '-' || k === '_') this.cam.zoomAt(this.w / 2, this.h / 2, 1.25);
    else if (k === 'Escape') { if (!$('modal').classList.contains('hidden') && this.state === STATE.PLAYING) this.closeModal(); else this.hidePanel(); }
    if (this.state !== STATE.PLAYING || this.paused) return;
    if (k === 't' || k === 'T') this.toggleTop();
    else if (k === 'h' || k === 'H') this.goHome();
    else if (k === 'Enter' && this.sel >= 0) this.onAction();
  },
  keyPan(dt) {
    if (!this.keys || !this.keys.size) return;
    let dx = 0, dy = 0;
    for (const k of this.keys) {
      if (k === 'ArrowLeft' || k === 'a') dx -= 1;
      if (k === 'ArrowRight' || k === 'd') dx += 1;
      if (k === 'ArrowUp' || k === 'w') dy -= 1;
      if (k === 'ArrowDown' || k === 's') dy += 1;
    }
    if (dx || dy) {
      const sp = this.cam.dist * 0.9 * dt;
      this.cam.goal = null;
      this.cam.tx += dx * sp; this.cam.tz += dy * sp;
      this.cam.clampTarget();
    }
  },
  pickCell(sx, sy) {
    const p = this.cam.groundAt(sx, sy);
    if (!p) return -1;
    const x = Math.floor(p.x), y = Math.floor(p.z);
    if (x < 0 || y < 0 || x >= this.map.W || y >= this.map.H) return -1;
    return y * this.map.W + x;
  },
  onTap(sx, sy) {
    const i = this.pickCell(sx, sy);
    if (this.state === STATE.TITLE) {
      if (i >= 0 && this.map.isLand(i)) this.selectTitlePref(this.map.initPref[i], true);
    } else if (this.state === STATE.PLAYING && !this.paused) {
      this.selectCell(i);
    }
  },
  resize() {
    this.w = window.innerWidth; this.h = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, CONFIG.MAX_DPR);
    this.cam.setViewport(this.w, this.h);
    if (this.renderer) this.renderer.resize(this.w, this.h, this.dpr);
  },

  // ------------------------------------------------ ゲームループ
  frame(now) {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastT) / 1000));
    this.lastT = now;
    this.clock += dt;
    if (this.renderer) {
      this.keyPan(dt);
      this.cam.update(dt);
      if (this.state === STATE.PLAYING && this.game && !this.paused) {
        this.game.update(dt);
        this.updateHud(false);
      }
      const playing = this.state === STATE.PLAYING && this.game;
      const blink = playing && !this.game.player.acted && !this.topView && !this.paused
        ? 0.5 + 0.5 * Math.sin(this.clock * Math.PI * 2 * CONFIG.BLINK_HZ) : 0;
      const top = this.cam.pitch > 80;
      const mixT = clamp((this.cam.pitch - CONFIG.CAMERA_PITCH) / (CONFIG.TOP_PITCH - CONFIG.CAMERA_PITCH), 0, 1);
      this.renderer.render(this.cam, {
        mix: CONFIG.OWNER_MIX + (CONFIG.OWNER_MIX_TOP - CONFIG.OWNER_MIX) * mixT,
        blink, sel: this.state === STATE.PLAYING ? this.sel : -1, top,
      });
      this.drawOverlay();
      if (this.state === STATE.PLAYING || this.state === STATE.GAMEOVER) {
        this.minimapT -= dt;
        if (this.minimapT <= 0) { this.minimapT = CONFIG.MINIMAP_REFRESH; this.drawMinimap(); }
        else if (this.cam.goal || this.keys.size || true) this.drawMinimapFrame();
      }
    }
    requestAnimationFrame((t) => this.frame(t));
  },
  drawMinimapFrame() {
    // 画像は再計算せず、枠だけ描き直す
    if (!this.mmImage) return;
    const saved = this.minimapDirty;
    this.minimapDirty = false;
    this.drawMinimap();
    this.minimapDirty = saved;
  },

  start() {
    this.resize();
    this.setState(STATE.LOADING);
    requestAnimationFrame((t) => { this.lastT = t; this.frame(t); });
  },
};

// テスト・デバッグ用
window.__jinchi = { App, CONFIG, STATE, get game() { return App.game; } };
App.start();
})();
