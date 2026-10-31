# -*- coding: utf-8 -*-
"""
地図データの前処理。

入力:
  data/japan.topojson  … dataofjapan/land の都道府県ポリゴン（出典：地球地図日本（国土地理院））
  標高タイル            … 地形（平地・森・山）の判定にだけ使う（AWS Terrain Tiles, terrarium形式, z8）
                          data/dem_cache/ にキャッシュする
出力:
  data/mapdata.json     … HTMLに埋め込むマップデータ
  data/preview/*.png    … 確認用のラスタライズ画像

使い方: python3 tools/preprocess.py
"""
import base64
import concurrent.futures as cf
import io
import json
import math
import os
import random
import sys
import time
import urllib.request

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(__file__))
from prefdata import PREFS, LINKS, CITIES  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA = os.path.join(ROOT, "data")
CACHE = os.path.join(DATA, "dem_cache")
PREVIEW = os.path.join(DATA, "preview")

# ---- グリッド定義 ----
DLON = 0.009
DLAT = 0.0072
W = 2400
H = 2160
LON0 = 128.25            # 左端の経度
LAT_TOP = 45.65          # 上端の緯度（行0が北）

# ---- インセット（位置をずらして表示する島々） ----
# region: 0=本土, 1=南西諸島（沖縄・奄美・トカラ）, 2=小笠原・硫黄島, 3=南鳥島
SHIFTS = {0: (0.0, 0.0), 1: (6.0, 14.0), 2: (3.5, 8.0), 3: (-7.4, 8.3)}
INSET_NAMES = {1: "沖縄・奄美（位置を移動して表示）", 2: "小笠原（位置を移動して表示）"}

# 地形コード
SEA, PLAIN, FOREST, MOUNTAIN, CITY = 0, 1, 2, 3, 4
SNOW = 8

DEM_Z = 8
DEM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"


def region_of(lon, lat):
    if lon > 150:
        return 3
    if lat < 30.1:
        return 1 if lon < 135 else 2
    return 0


def to_grid(lon, lat):
    """経度緯度 → グリッド座標（連続値。x=列, y=行）"""
    return (lon - LON0) / DLON, (LAT_TOP - lat) / DLAT


def grid_to_lonlat(x, y):
    return LON0 + x * DLON, LAT_TOP - y * DLAT


# ---------------------------------------------------------------- topojson
def load_topology():
    with open(os.path.join(DATA, "japan.topojson"), encoding="utf-8") as f:
        topo = json.load(f)
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for a in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in a:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(np.array(pts, dtype=np.float64))
    return topo, arcs


def ring_coords(arcs, ring):
    pts = []
    for ai in ring:
        a = arcs[ai] if ai >= 0 else arcs[~ai][::-1]
        if pts:
            a = a[1:]
        pts.extend(a.tolist())
    return np.array(pts)


def shifted(pts, region):
    dx, dy = SHIFTS[region]
    out = pts.copy()
    out[:, 0] += dx
    out[:, 1] += dy
    return out


# ---------------------------------------------------------------- rasterize
def rasterize(topo, arcs):
    pref = np.zeros((H, W), np.uint8)
    region = np.zeros((H, W), np.uint8)
    for g in topo["objects"]["japan"]["geometries"]:
        pid = g["properties"]["id"]
        polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
        for poly in polys:
            ext = ring_coords(arcs, poly[0])
            c = ext.mean(axis=0)
            reg = region_of(c[0], c[1])
            rings = [shifted(ring_coords(arcs, r), reg) for r in poly]
            gx = [to_grid(p[:, 0], p[:, 1]) for p in rings]
            xs = np.concatenate([g_[0] for g_ in gx])
            ys = np.concatenate([g_[1] for g_ in gx])
            x0, x1 = int(math.floor(xs.min())) - 1, int(math.ceil(xs.max())) + 2
            y0, y1 = int(math.floor(ys.min())) - 1, int(math.ceil(ys.max())) + 2
            x0, y0 = max(x0, 0), max(y0, 0)
            x1, y1 = min(x1, W), min(y1, H)
            if x1 <= x0 or y1 <= y0:
                continue
            img = Image.new("L", (x1 - x0, y1 - y0), 0)
            dr = ImageDraw.Draw(img)
            for k, (rx, ry) in enumerate(gx):
                xy = list(zip((rx - x0 - 0.5).tolist(), (ry - y0 - 0.5).tolist()))
                if len(xy) < 3:
                    continue
                dr.polygon(xy, fill=1 if k == 0 else 0)
            m = np.array(img, dtype=bool)
            sub = pref[y0:y1, x0:x1]
            sub[m] = pid
            region[y0:y1, x0:x1][m] = reg
    return pref, region


# ---------------------------------------------------------------- DEM
def merc_px(lon, lat, z):
    n = 256 * (2 ** z)
    x = (lon + 180.0) / 360.0 * n
    lr = np.radians(lat)
    y = (1.0 - np.log(np.tan(lr) + 1.0 / np.cos(lr)) / math.pi) / 2.0 * n
    return x, y


def fetch_tile(x, y):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{DEM_Z}_{x}_{y}.png")
    if not os.path.exists(path):
        url = DEM_URL.format(z=DEM_Z, x=x, y=y)
        for attempt in range(5):
            try:
                with urllib.request.urlopen(url, timeout=30) as r:
                    data = r.read()
                with open(path, "wb") as f:
                    f.write(data)
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
    im = np.array(Image.open(path).convert("RGB"), dtype=np.float32)
    return (im[:, :, 0] * 256 + im[:, :, 1] + im[:, :, 2] / 256) - 32768


def sample_elevation(lons, lats):
    """各点の標高[m]を最近傍で取得（3x3の平均で少しなめらかに）"""
    px, py = merc_px(lons, lats, DEM_Z)
    tx = (px // 256).astype(int)
    ty = (py // 256).astype(int)
    keys = sorted(set(zip(tx.tolist(), ty.tolist())))
    print(f"  DEM tiles: {len(keys)}")
    tiles = {}
    with cf.ThreadPoolExecutor(8) as ex:
        for k, t in zip(keys, ex.map(lambda k: fetch_tile(*k), keys)):
            tiles[k] = ndimage.uniform_filter(t, 3)
    out = np.zeros(len(lons), np.float32)
    ix = np.clip((px - tx * 256).astype(int), 0, 255)
    iy = np.clip((py - ty * 256).astype(int), 0, 255)
    order = np.lexsort((ty, tx))
    for k in keys:
        sel = (tx == k[0]) & (ty == k[1])
        out[sel] = tiles[k][iy[sel], ix[sel]]
    del order
    return np.maximum(out, 0)


# 日本海側（豪雪地帯）の県
SNOWY = {1: 350, 2: 450, 5: 500, 6: 450, 15: 450, 16: 400, 17: 300, 18: 250,
         3: 200, 7: 200, 20: 300, 21: 250, 31: 150, 32: 100, 26: 100, 28: 100, 4: 100, 10: 150}


def classify_terrain(pref, region):
    land = pref > 0
    ys, xs = np.nonzero(land)
    lon, lat = grid_to_lonlat(xs + 0.5, ys + 0.5)
    olon = lon.copy()
    olat = lat.copy()
    reg = region[ys, xs]
    for r, (dx, dy) in SHIFTS.items():
        s = reg == r
        olon[s] -= dx
        olat[s] -= dy
    print("sampling DEM ...")
    elev_land = sample_elevation(olon, olat)
    elev = np.zeros((H, W), np.float32)
    elev[ys, xs] = elev_land

    # 傾斜（1マス≒0.8km）
    gy, gx = np.gradient(ndimage.gaussian_filter(elev, 0.7))
    slope = np.hypot(gx, gy) / 800.0

    # 市街地スコア
    urb = np.zeros(len(xs), np.float32)
    kmx = 111.0 * np.cos(np.radians(olat))
    for clon, clat, pop in CITIES:
        sigma = 1.6 * math.sqrt(pop / 10.0) + 1.0
        dxk = (olon - clon) * kmx
        dyk = (olat - clat) * 111.0
        d2 = dxk * dxk + dyk * dyk
        near = d2 < (4 * sigma) ** 2
        urb[near] += np.exp(-d2[near] / (2 * sigma * sigma)) * min(pop, 300) / 50.0
    rng = np.random.default_rng(7)
    noise = ndimage.gaussian_filter(rng.standard_normal((H, W)).astype(np.float32), 2.5) * 6
    nz = noise[ys, xs]

    e = elev_land
    s = slope[ys, xs]
    t = np.full(len(xs), PLAIN, np.uint8)
    hilly = (e > 140 + nz * 40) | (s > 0.09 + nz * 0.02)
    t[hilly] = FOREST
    t[(e > 1000 + nz * 120) | ((e > 600) & (s > 0.22))] = MOUNTAIN
    city = (urb + nz * 0.25 > 0.55) & (e < 160) & (s < 0.08)
    t[city] = CITY
    # 雪：緯度と日本海側で雪線を下げる
    pid = pref[ys, xs]
    snowline = 2700 - (olat - 34.0) * 200
    bonus = np.zeros(len(xs), np.float32)
    for k, v in SNOWY.items():
        bonus[pid == k] = v
    snowline = snowline - bonus + nz * 60
    snow = (e > snowline) & (t != CITY)
    t[snow] |= SNOW

    terr = np.zeros((H, W), np.uint8)
    terr[ys, xs] = t
    # ノイズ除去（多数決で1マスの点を消す → RLEが短くなる）
    terr = majority_clean(terr, land)
    return terr, elev


def majority_clean(terr, land):
    out = terr.copy()
    codes = [PLAIN, FOREST, MOUNTAIN, CITY, PLAIN | SNOW, FOREST | SNOW, MOUNTAIN | SNOW]
    counts = np.stack([ndimage.uniform_filter((terr == c).astype(np.float32), 3) for c in codes])
    best = np.array(codes, np.uint8)[counts.argmax(0)]
    own = np.zeros(terr.shape, np.float32)
    for i, c in enumerate(codes):
        own[terr == c] = counts[i][terr == c]
    rep = land & (own < 0.25)
    out[rep] = best[rep]
    out[~land] = SEA
    return out


# ---------------------------------------------------------------- lines
def dp_simplify(pts, eps):
    """ダグラス・ポイカー法（反復版）"""
    n = len(pts)
    if n < 3:
        return pts
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        p, q = pts[a], pts[b]
        seg = pts[a + 1:b]
        d = q - p
        L = math.hypot(d[0], d[1])
        if L < 1e-9:
            dist = np.hypot(seg[:, 0] - p[0], seg[:, 1] - p[1])
        else:
            dist = np.abs(d[0] * (seg[:, 1] - p[1]) - d[1] * (seg[:, 0] - p[0])) / L
        i = int(dist.argmax())
        if dist[i] > eps:
            m = a + 1 + i
            keep[m] = True
            stack.append((a, m))
            stack.append((m, b))
    return pts[keep]


def build_lines(topo, arcs):
    users = [set() for _ in arcs]
    for g in topo["objects"]["japan"]["geometries"]:
        pid = g["properties"]["id"]
        polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
        for poly in polys:
            for ring in poly:
                for ai in ring:
                    users[ai if ai >= 0 else ~ai].add(pid)
    coast, border = [], []
    npts = 0
    for i, a in enumerate(arcs):
        reg = region_of(*a[0])
        p = shifted(a, reg)
        gx, gy = to_grid(p[:, 0], p[:, 1])
        g = np.stack([gx, gy], 1)
        s = dp_simplify(g, 0.45)
        if len(s) < 2:
            continue
        # 小さすぎる島の海岸線は省略（マス自体は残る）
        span = np.ptp(s, axis=0).max()
        if len(users[i]) < 2 and span < 1.5:
            continue
        q = np.round(s * 4).astype(int)  # 1/4マス精度
        flat = [int(q[0, 0]), int(q[0, 1])]
        for k in range(1, len(q)):
            flat += [int(q[k, 0] - q[k - 1, 0]), int(q[k, 1] - q[k - 1, 1])]
        npts += len(q)
        (border if len(users[i]) >= 2 else coast).append(flat)
    print(f"  lines: coast {len(coast)} border {len(border)} points {npts}")
    return coast, border


# ---------------------------------------------------------------- links
def nearest_cell_of(pref, pid, lon, lat, region_hint=None):
    reg = region_of(lon, lat)
    dx, dy = SHIFTS[reg]
    gx, gy = to_grid(lon + dx, lat + dy)
    r = 4
    while r < 200:
        x0, x1 = max(int(gx) - r, 0), min(int(gx) + r + 1, W)
        y0, y1 = max(int(gy) - r, 0), min(int(gy) + r + 1, H)
        sub = pref[y0:y1, x0:x1] == pid
        if sub.any():
            yy, xx = np.nonzero(sub)
            d = (xx + x0 + 0.5 - gx) ** 2 + (yy + y0 + 0.5 - gy) ** 2
            k = int(d.argmin())
            return int((yy[k] + y0) * W + xx[k] + x0)
        r *= 2
    raise RuntimeError(f"no cell for pref {pid} near {lon},{lat}")


class UF:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, a):
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a != b:
            self.p[b] = a
            return True
        return False


def build_links(pref):
    land = pref > 0
    lab, n = ndimage.label(land, structure=np.ones((3, 3), int))
    print(f"  land components: {n}")
    named = []
    for name, kind, pts in LINKS:
        cells = [nearest_cell_of(pref, p, lo, la) for p, lo, la in pts]
        for a, b in zip(cells, cells[1:]):
            named.append({"name": name, "kind": kind, "a": a, "b": b})
    uf = UF(n + 1)
    for l in named:
        uf.union(lab.flat[l["a"]], lab.flat[l["b"]])
    # 海岸マス（海に接する陸）
    coastm = land & ~ndimage.binary_erosion(land, structure=np.ones((3, 3)), border_value=0)
    cidx = np.flatnonzero(coastm)
    cy, cx = np.divmod(cidx, W)
    clab = lab.flat[cidx]
    tree = cKDTree(np.stack([cx, cy], 1))
    auto = []
    while True:
        roots = np.array([uf.find(int(c)) for c in range(n + 1)])
        croot = roots[clab]
        uniq, cnt = np.unique(croot, return_counts=True)
        if len(uniq) <= 1:
            break
        # 一番小さいグループから、ほかのグループの最寄りマスへつなぐ
        r = uniq[cnt.argmin()]
        sel = np.flatnonzero(croot == r)
        best = None
        k = 16
        while best is None:
            d, j = tree.query(np.stack([cx[sel], cy[sel]], 1), k=min(k, len(cidx)))
            d = np.atleast_2d(d)
            j = np.atleast_2d(j)
            other = croot[j] != r
            if other.any():
                dd = np.where(other, d, np.inf)
                a = np.unravel_index(dd.argmin(), dd.shape)
                best = (sel[a[0]], j[a])
            else:
                if k >= len(cidx):
                    break
                k *= 4
        if best is None:
            break
        ia, ib = cidx[best[0]], cidx[best[1]]
        uf.union(int(lab.flat[ia]), int(lab.flat[ib]))
        auto.append({"a": int(ia), "b": int(ib)})
    print(f"  links: named {len(named)} auto {len(auto)}")
    return named, auto


# ---------------------------------------------------------------- adjacency & colors
def pref_adjacency(pref, links):
    adj = set()
    a = pref
    for dy, dx in [(0, 1), (1, 0), (1, 1), (1, -1)]:
        if dx >= 0:
            p, q = a[:H - dy, :W - dx], a[dy:, dx:]
        else:
            p, q = a[:H - dy, -dx:], a[dy:, :W + dx]
        m = (p > 0) & (q > 0) & (p != q)
        pairs = np.unique(np.stack([p[m], q[m]], 1), axis=0)
        for u, v in pairs:
            adj.add((min(u, v), max(u, v)))
    for l in links:
        u, v = int(pref.flat[l["a"]]), int(pref.flat[l["b"]])
        if u != v:
            adj.add((min(u, v), max(u, v)))
    return sorted((int(u), int(v)) for u, v in adj)


def srgb_to_lab(rgb):
    c = rgb / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    L = 116 * f[:, 1] - 16
    A = 500 * (f[:, 0] - f[:, 1])
    B = 200 * (f[:, 1] - f[:, 2])
    return np.stack([L, A, B], 1)


def assign_colors(adj, seed=3):
    """CIELABのΔEで、隣接県どうしの最小色差が最大になるよう焼きなまし法で割り当てる"""
    steps = np.arange(0, 256, 15)
    rgb = np.array([(r, g, b) for r in steps for g in steps for b in steps], np.float64)
    lab = srgb_to_lab(rgb)
    ok = (lab[:, 0] > 32) & (lab[:, 0] < 93)
    rgb, lab = rgb[ok], lab[ok]
    nc = len(lab)
    rng = random.Random(seed)
    nb = {i: [] for i in range(1, 48)}
    for u, v in adj:
        nb[u].append(v)
        nb[v].append(u)
    D = np.sqrt(((lab[:, None, :] - lab[None, :, :]) ** 2).sum(-1)).astype(np.float32)

    def score(col):
        mn = min(D[col[u], col[v]] for u, v in adj)
        # 全県の中でも似すぎた色を避ける（副目的）
        cs = np.array([col[i] for i in range(1, 48)])
        dm = D[np.ix_(cs, cs)] + np.eye(47) * 999
        allmin = dm.min()
        soft = sum(min(D[col[u], col[v]], 110) for u, v in adj) / len(adj)
        return 3.0 * min(mn, 72) + min(allmin, 12) + 0.05 * soft, mn, allmin

    best_col, best_s = None, (-1, 0, 0)
    for restart in range(10):
        col = {i: rng.randrange(nc) for i in range(1, 48)}
        cur = score(col)
        T = 40.0
        for it in range(16000):
            i = rng.randrange(1, 48)
            old = col[i]
            col[i] = rng.randrange(nc)
            s = score(col)
            if s[0] >= cur[0] or rng.random() < math.exp((s[0] - cur[0]) / T):
                cur = s
            else:
                col[i] = old
            T = max(0.05, T * 0.99955)
        if cur[0] > best_s[0]:
            best_s, best_col = cur, dict(col)
        print(f"  colors restart {restart}: min neighbor dE={cur[1]:.1f} min all dE={cur[2]:.1f}")
    print(f"  colors best: min neighbor dE={best_s[1]:.1f}, min all dE={best_s[2]:.1f}")
    out = {}
    for i in range(1, 48):
        r, g, b = rgb[best_col[i]].astype(int).tolist()
        out[i] = "#%02x%02x%02x" % (r, g, b)
    return out, float(best_s[1])


# ---------------------------------------------------------------- encoding
def rle_b64(arr):
    flat = arr.ravel()
    change = np.flatnonzero(np.diff(flat)) + 1
    starts = np.concatenate([[0], change])
    lens = np.diff(np.concatenate([starts, [len(flat)]]))
    vals = flat[starts]
    out = bytearray()
    for v, L in zip(vals.tolist(), lens.tolist()):
        out.append(v)
        while True:  # varint
            b = L & 0x7F
            L >>= 7
            if L:
                out.append(b | 0x80)
            else:
                out.append(b)
                break
    return base64.b64encode(bytes(out)).decode("ascii"), len(vals)


# ---------------------------------------------------------------- preview
def save_previews(pref, terr, colors, named, auto, capitals):
    os.makedirs(PREVIEW, exist_ok=True)
    pal = np.zeros((256, 3), np.uint8)
    pal[0] = (20, 40, 80)
    for i, c in colors.items():
        pal[i] = [int(c[k:k + 2], 16) for k in (1, 3, 5)]
    img = Image.fromarray(pal[pref])
    dr = ImageDraw.Draw(img)
    for l in named:
        ay, ax = divmod(l["a"], W)
        by, bx = divmod(l["b"], W)
        dr.line([(ax, ay), (bx, by)], fill=(255, 255, 255), width=3)
    for l in auto:
        ay, ax = divmod(l["a"], W)
        by, bx = divmod(l["b"], W)
        dr.line([(ax, ay), (bx, by)], fill=(200, 200, 200), width=1)
    for c in capitals:
        y, x = divmod(c, W)
        dr.ellipse([x - 6, y - 6, x + 6, y + 6], fill=(0, 0, 0), outline=(255, 255, 255))
    img.resize((W // 3, H // 3), Image.LANCZOS).save(os.path.join(PREVIEW, "prefectures_small.png"))
    tp = np.zeros((16, 3), np.uint8)
    tp[SEA] = (25, 50, 90)
    tp[PLAIN] = (150, 190, 100)
    tp[FOREST] = (60, 120, 60)
    tp[MOUNTAIN] = (130, 110, 90)
    tp[CITY] = (190, 190, 200)
    tp[PLAIN | SNOW] = (235, 240, 245)
    tp[FOREST | SNOW] = (205, 220, 225)
    tp[MOUNTAIN | SNOW] = (250, 250, 255)
    ti = Image.fromarray(tp[terr])
    ti.resize((W // 3, H // 3), Image.LANCZOS).save(os.path.join(PREVIEW, "terrain_small.png"))
    # 関東の拡大
    ti.crop((1150, 1050, 1500, 1350)).resize((700, 600), Image.NEAREST).save(os.path.join(PREVIEW, "terrain_kanto.png"))


# ---------------------------------------------------------------- main
def main():
    t0 = time.time()
    topo, arcs = load_topology()
    print("rasterizing ...")
    pref, region = rasterize(topo, arcs)
    land = pref > 0
    print(f"  grid {W}x{H}, land cells {int(land.sum())}")
    for pid in range(1, 48):
        c = int((pref == pid).sum())
        if c == 0:
            raise RuntimeError(f"pref {pid} has no cells")
    terr, elev = classify_terrain(pref, region)
    for code, name in [(PLAIN, "plain"), (FOREST, "forest"), (MOUNTAIN, "mountain"), (CITY, "city")]:
        print(f"  {name}: {int(((terr & 7) == code).sum())}")
    print(f"  snow: {int(((terr & SNOW) > 0).sum())}")
    print("lines ...")
    coast, border = build_lines(topo, arcs)
    print("links ...")
    named, auto = build_links(pref)
    adj = pref_adjacency(pref, named + auto)
    print(f"  pref adjacency edges: {len(adj)}")
    print("colors ...")
    colors, min_de = assign_colors(adj)

    capitals = {}
    for pid, (name, short, pop, cap, lon, lat, area) in PREFS.items():
        capitals[pid] = nearest_cell_of(pref, pid, lon, lat)

    prefs = []
    for pid, (name, short, pop, cap, lon, lat, area) in PREFS.items():
        prefs.append({"id": pid, "name": name, "short": short, "pop": pop, "capName": cap,
                      "capital": capitals[pid], "color": colors[pid], "area": area,
                      "cells": int((pref == pid).sum())})

    pref_b64, pref_runs = rle_b64(pref)
    terr_b64, terr_runs = rle_b64(terr)
    print(f"  RLE runs: pref {pref_runs}, terrain {terr_runs}; base64 {len(pref_b64)//1024}KB + {len(terr_b64)//1024}KB")

    insets = []
    for r, label in INSET_NAMES.items():
        ys, xs = np.nonzero(region == r)
        if r == 2:
            ys3, xs3 = np.nonzero(region == 3)
            ys, xs = np.concatenate([ys, ys3]), np.concatenate([xs, xs3])
        pad = 25
        insets.append({"label": label, "x0": int(xs.min()) - pad, "y0": int(ys.min()) - pad,
                       "x1": int(xs.max()) + pad, "y1": int(ys.max()) + pad})

    shift_rects = []
    for r in (1, 2, 3):
        ys, xs = np.nonzero(region == r)
        if len(xs):
            shift_rects.append({"x0": int(xs.min()) - 10, "y0": int(ys.min()) - 10, "x1": int(xs.max()) + 10,
                                "y1": int(ys.max()) + 10, "dlon": SHIFTS[r][0], "dlat": SHIFTS[r][1]})

    out = {
        "source": "地球地図日本（国土地理院）／ dataofjapan/land",
        "W": W, "H": H, "lon0": LON0, "latTop": LAT_TOP, "dlon": DLON, "dlat": DLAT,
        "landCells": int(land.sum()),
        "prefs": prefs,
        "pref": pref_b64,
        "terrain": terr_b64,
        "coast": coast,
        "border": border,
        "links": named,
        "autoLinks": [[l["a"], l["b"]] for l in auto],
        "adjacency": adj,
        "minNeighborDeltaE": round(min_de, 1),
        "insets": insets,
        "shiftRects": shift_rects,
    }
    with open(os.path.join(DATA, "mapdata.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote mapdata.json ({os.path.getsize(os.path.join(DATA, 'mapdata.json'))//1024}KB)")
    save_previews(pref, terr, colors, named, auto, list(capitals.values()))
    print(f"done in {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
