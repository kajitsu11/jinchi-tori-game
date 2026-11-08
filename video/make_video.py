# -*- coding: utf-8 -*-
"""雑学動画「生物は種のためではなく、遺伝子のために生きている」生成スクリプト (3Dスタイル版).

素材:
  - 写真: Wikimedia Commons (各写真の撮影者・ライセンスは photos/credits.json)
  - 音声: VOICEVOX:ずんだもん  https://voicevox.hiroshiba.jp/

必要: pillow, numpy, ffmpeg, 起動中の VOICEVOX ENGINE (既定 http://127.0.0.1:50021)
使い方: python3 make_video.py [--preview]  ->  selfish_gene.mp4
"""
import hashlib
import json
import math
import os
import subprocess
import sys
import urllib.parse
import urllib.request
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS = 1920, 1080, 30
SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "selfish_gene.mp4")
TMP = os.environ.get("VIDEO_TMP", os.path.join(HERE, "_build"))
VOICEVOX = os.environ.get("VOICEVOX_URL", "http://127.0.0.1:50021")
SPEAKER = int(os.environ.get("VOICEVOX_SPEAKER", "3"))  # 3 = ずんだもん(ノーマル)
CREDIT_VOICE = "VOICEVOX:ずんだもん、VOICEVOX:四国めたん"
os.makedirs(TMP, exist_ok=True)

FONT_PATH = "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf"
_fonts = {}


def font(size):
    size = int(size)
    if size not in _fonts:
        _fonts[size] = ImageFont.truetype(FONT_PATH, size)
    return _fonts[size]


# ---------------------------------------------------------------- colors
WHITE = (250, 250, 255)
YELLOW = (255, 214, 64)
RED = (255, 84, 96)
BLUE = (80, 160, 255)
GREEN = (70, 215, 130)
ORANGE = (255, 150, 50)
GRAY = (190, 198, 220)
PINK = (255, 120, 190)
PURPLE = (170, 110, 255)
NAVY = (18, 22, 52)


def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def ease(x):
    x = clamp(x)
    return 1 - (1 - x) ** 3


def appear(t, start, dur=0.5):
    return ease((t - start) / dur)


def pop(t, start, dur=0.55):
    """0→1 にオーバーシュートしながら弾む (スケール用)."""
    x = clamp((t - start) / dur)
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    return 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2


def rgba(c, a):
    return (c[0], c[1], c[2], int(255 * clamp(a)))


def darker(c, k=0.55):
    return tuple(int(v * k) for v in c)


def lighter(c, k=0.45):
    return tuple(int(v + (255 - v) * k) for v in c)


# ---------------------------------------------------------------- background (3D studio)
def make_bg():
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    top = np.array([30, 24, 78], np.float32)
    bot = np.array([10, 14, 40], np.float32)
    g = (yy / H)[..., None]
    img = top * (1 - g) + bot * g
    # 中央のスポットライト
    r = np.sqrt(((xx - W / 2) / (W * 0.55)) ** 2 + ((yy - H * 0.38) / (H * 0.6)) ** 2)
    glow = np.clip(1 - r, 0, 1)[..., None] ** 1.6
    img = img + glow * np.array([70, 80, 150], np.float32)
    # 床 (遠近法グリッド)
    horizon = 760
    floor = yy >= horizon
    fy = (yy - horizon) / (H - horizon)
    img[floor] = img[floor] * 0.75 + np.array([20, 30, 80], np.float32) * 0.25
    vx = W / 2
    grid = np.zeros((H, W), np.float32)
    for k in range(-14, 15):
        x_bottom = vx + k * 260
        t = np.clip(fy, 0, 1)
        xl = vx + (x_bottom - vx) * t
        grid = np.maximum(grid, np.where(floor & (np.abs(xx - xl) < 1.2 + 1.5 * t), 0.6 * t, 0))
    for j in range(1, 12):
        z = j / 12
        ly = horizon + (H - horizon) * z ** 2
        grid = np.maximum(grid, np.where(np.abs(yy - ly) < 1 + z, 0.5 * z, 0))
    img = img + grid[..., None] * np.array([80, 120, 255], np.float32)
    # 地平線のハイライト
    img = img + (np.exp(-((yy - horizon) / 6) ** 2) * 0.6)[..., None] * np.array([90, 120, 255], np.float32)
    # ビネット
    v = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
    img = img * (1 - 0.35 * np.clip(v - 0.6, 0, 1))[..., None]
    # 浮遊する光の粒
    rng = np.random.default_rng(3)
    base = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")
    dots = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dots)
    for _ in range(70):
        x, y, s = rng.uniform(0, W), rng.uniform(0, horizon), rng.uniform(1.5, 5)
        dd.ellipse([x - s, y - s, x + s, y + s], fill=(160, 190, 255, int(rng.uniform(40, 120))))
    dots = dots.filter(ImageFilter.GaussianBlur(1.5))
    base.paste(dots, (0, 0), dots)
    return base


BG = make_bg()

# ---------------------------------------------------------------- photos (Wikimedia Commons)
PHOTOS = os.path.join(HERE, "photos")
_ph = {}
_cover = {}
_pol = {}
_round = {}
_dim = {}


def has_photo(key):
    return os.path.exists(os.path.join(PHOTOS, key + ".jpg"))


def _photo(key):
    if key not in _ph:
        _ph[key] = Image.open(os.path.join(PHOTOS, key + ".jpg")).convert("RGB")
    return _ph[key]


def _cover_img(key, w, h, focus=(0.5, 0.5)):
    k = (key, w, h, focus)
    if k not in _cover:
        if len(_cover) > 60:
            _cover.clear()
        im = _photo(key)
        s = max(w / im.width, h / im.height)
        nw, nh = max(w, round(im.width * s)), max(h, round(im.height * s))
        im = im.resize((nw, nh), Image.LANCZOS)
        x0 = int((nw - w) * focus[0])
        y0 = int((nh - h) * focus[1])
        _cover[k] = im.crop((x0, y0, x0 + w, y0 + h))
    return _cover[k]


def _dim_layer(strength):
    if strength not in _dim:
        yy = np.linspace(0, 1, H)[:, None]
        xx = np.linspace(-1, 1, W)[None, :]
        al = strength + (1 - strength) * 0.55 * (np.clip(1 - yy / 0.25, 0, 1) ** 2 + np.clip((yy - 0.62) / 0.38, 0, 1) ** 1.5)
        al = al + 0.25 * np.abs(xx) ** 3
        al = np.clip(al, 0, 0.92)
        arr = np.zeros((H, W, 4), np.uint8)
        arr[..., 0], arr[..., 1], arr[..., 2] = 8, 10, 30
        arr[..., 3] = (al * 255).astype(np.uint8)
        _dim[strength] = Image.fromarray(arr, "RGBA")
    return _dim[strength]


def photo_bg(img, key, t, T, dim=0.45, zoom=(1.0, 1.12), focus=(0.5, 0.5), pan=(0.0, 0.0), blur=False):
    """全画面の写真背景 (ゆっくりズーム/パンする Ken Burns 効果)."""
    if not has_photo(key):
        return
    bw, bh = int(W * 1.2), int(H * 1.2)
    big = _cover_img(key, bw, bh, focus)
    if blur:
        k = ("blur", key, focus)
        if k not in _cover:
            _cover[k] = big.filter(ImageFilter.GaussianBlur(14))
        big = _cover[k]
    p = clamp(t / max(T, 0.1))
    p = p * p * (3 - 2 * p)
    z = zoom[0] + (zoom[1] - zoom[0]) * p
    cw, ch = bw / 1.2 / z * 1.0, bh / 1.2 / z
    cx = bw / 2 + pan[0] * (bw - cw) / 2 * (2 * p - 1)
    cy = bh / 2 + pan[1] * (bh - ch) / 2 * (2 * p - 1)
    box = (cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2)
    img.paste(big.resize((W, H), Image.BILINEAR, box=box))
    lay = _dim_layer(dim)
    img.paste(lay, (0, 0), lay)


def polaroid(img, key, cx, cy, w, h, a=1.0, rot=0.0, scale=1.0, focus=(0.5, 0.5), caption=None, flip=False, gray=False):
    """白フチ付きの写真カード (影つき・少し傾ける)."""
    if a <= 0.02 or scale <= 0.05 or not has_photo(key):
        return
    k = (key, w, h, round(rot, 1), focus, caption, flip, gray)
    if k not in _pol:
        if len(_pol) > 80:
            _pol.clear()
        b = 14
        cap = 56 if caption else b
        ph = _cover_img(key, w, h, focus)
        if flip:
            ph = ph.transpose(Image.FLIP_LEFT_RIGHT)
        if gray:
            ph = Image.blend(ph, ph.convert("L").convert("RGB"), 0.8)
        pad = 40
        card_im = Image.new("RGBA", (w + 2 * b + 2 * pad, h + b + cap + 2 * pad), (0, 0, 0, 0))
        sh = Image.new("RGBA", card_im.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).rectangle([pad + 8, pad + 14, pad + w + 2 * b + 8, pad + h + b + cap + 14], fill=(0, 0, 0, 170))
        card_im.alpha_composite(sh.filter(ImageFilter.GaussianBlur(14)))
        cd = ImageDraw.Draw(card_im)
        cd.rectangle([pad, pad, pad + w + 2 * b, pad + h + b + cap], fill=(250, 248, 240, 255))
        card_im.paste(ph, (pad + b, pad + b))
        if caption:
            cd.text((pad + b + w / 2, pad + b + h + cap / 2), caption, font=font(34), fill=(40, 40, 50), anchor="mm")
        if rot:
            card_im = card_im.rotate(rot, resample=Image.BICUBIC, expand=True)
        _pol[k] = card_im
    im = _pol[k]
    q = round(scale * 20) / 20
    if q != 1.0 or a < 0.99:
        k2 = (k, q, round(a, 1))
        if k2 not in _pol:
            im2 = im.resize((max(1, int(im.width * q)), max(1, int(im.height * q))), Image.BILINEAR) if q != 1.0 else im.copy()
            if a < 0.99:
                im2.putalpha(im2.getchannel("A").point(lambda v: int(v * a)))
            _pol[k2] = im2
        im = _pol[k2]
    img.paste(im, (int(cx - im.width / 2), int(cy - im.height / 2)), im)


def roundphoto(img, key, cx, cy, r, a=1.0, scale=1.0, ring=WHITE, focus=(0.5, 0.5), gray=False):
    if a <= 0.02 or scale <= 0.05 or not has_photo(key):
        return
    rr = int(r * round(scale * 20) / 20)
    if rr < 6:
        return
    k = (key, rr, ring, focus, round(a, 1), gray)
    if k not in _round:
        if len(_round) > 200:
            _round.clear()
        d2 = rr * 2
        ph = _cover_img(key, d2, d2, focus) if rr == int(r) else _cover_img(key, int(r) * 2, int(r) * 2, focus).resize((d2, d2))
        if gray:
            ph = Image.blend(ph, ph.convert("L").convert("RGB"), 0.8)
        pad = 24
        out = Image.new("RGBA", (d2 + 2 * pad, d2 + 2 * pad), (0, 0, 0, 0))
        sh = Image.new("RGBA", out.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).ellipse([pad + 4, pad + 10, pad + d2 + 4, pad + d2 + 10], fill=(0, 0, 0, 160))
        out.alpha_composite(sh.filter(ImageFilter.GaussianBlur(8)))
        mask = Image.new("L", (d2, d2), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, d2 - 1, d2 - 1], fill=255)
        out.paste(ph, (pad, pad), mask)
        ImageDraw.Draw(out).ellipse([pad, pad, pad + d2 - 1, pad + d2 - 1], outline=ring + (255,), width=max(3, rr // 14))
        if a < 0.99:
            out.putalpha(out.getchannel("A").point(lambda v: int(v * a)))
        _round[k] = out
    im = _round[k]
    img.paste(im, (int(cx - im.width / 2), int(cy - im.height / 2)), im)



# ---------------------------------------------------------------- 3D CG sequences (three.js で事前レンダリング)
SEQ_DIR = os.environ.get("SEQ3D", os.path.join(HERE, "_3d"))
_seqmeta = {}
_seqimg = {}


def seq_meta(name):
    if name not in _seqmeta:
        p = os.path.join(SEQ_DIR, name, "meta.json")
        m = json.load(open(p)) if os.path.exists(p) else None
        if m:
            # 透明な余白を切り詰める (数フレームの不透明部分の和集合)
            box = None
            for i in sorted({0, m["frames"] // 3, 2 * m["frames"] // 3, m["frames"] - 1}):
                b = Image.open(os.path.join(SEQ_DIR, name, f"{i:04d}.png")).getchannel("A").getbbox()
                if b:
                    box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
            pad = 12
            m["bbox"] = (max(0, box[0] - pad), max(0, box[1] - pad), box[2] + pad, box[3] + pad) if box else None
        _seqmeta[name] = m
    return _seqmeta[name]


def seq_index(name, t):
    m = seq_meta(name)
    n, secs = m["frames"], m["seconds"]
    if m["loop"]:
        return int((t % secs) / secs * n) % n
    return int(round(clamp(t / secs) * (n - 1)))


def seq3d(img, name, cx, cy, h, t, a=1.0, scale=1.0):
    """3D CGの連番を (cx,cy) 中心・高さ h で合成. 戻り値: (倍率, 左, 上, フレーム番号)."""
    m = seq_meta(name)
    if m is None or a <= 0.02 or scale <= 0.05:
        return None
    i = seq_index(name, t)
    hh = max(8, int(h * round(scale * 20) / 20))
    k = (name, i, hh, round(a, 1))
    if k not in _seqimg:
        if len(_seqimg) > 400:
            _seqimg.clear()
        im = Image.open(os.path.join(SEQ_DIR, name, f"{i:04d}.png")).convert("RGBA")
        if m.get("bbox"):
            im = im.crop(m["bbox"])
        f = hh / im.height
        im = im.resize((max(1, int(im.width * f)), hh), Image.LANCZOS)
        if a < 0.99:
            im.putalpha(im.getchannel("A").point(lambda v: int(v * a)))
        _seqimg[k] = (im, f)
    im, f = _seqimg[k]
    left, top = int(cx - im.width / 2), int(cy - im.height / 2)
    img.paste(im, (left, top), im)
    ox, oy = (m["bbox"][0], m["bbox"][1]) if m.get("bbox") else (0, 0)
    return f, left - ox * f, top - oy * f, i

# ---------------------------------------------------------------- vector marks
def stamp_x(d, cx, cy, s, a=1.0, color=RED):
    if a <= 0.02:
        return
    s *= a
    wdt = max(8, int(s * 0.28))
    for off, col in ((6, darker(color, 0.4)), (0, color)):
        d.line([cx - s + off, cy - s + off, cx + s + off, cy + s + off], fill=rgba(col, min(1, a * 1.3)), width=wdt)
        d.line([cx - s + off, cy + s + off, cx + s + off, cy - s + off], fill=rgba(col, min(1, a * 1.3)), width=wdt)


def check_mark(d, cx, cy, s, a=1.0, color=GREEN):
    if a <= 0.02:
        return
    d.ellipse([cx - s, cy - s, cx + s, cy + s], fill=rgba(color, a), outline=rgba(lighter(color, .5), a), width=3)
    d.line([(cx - s * 0.5, cy), (cx - s * 0.12, cy + s * 0.4), (cx + s * 0.55, cy - s * 0.42)], fill=rgba(WHITE, a), width=max(4, int(s * 0.22)), joint="curve")


def heart(d, cx, cy, s, a=1.0, color=(255, 70, 110)):
    if a <= 0.02:
        return
    s *= a
    pts = []
    for i in range(60):
        th = i / 60 * 2 * math.pi
        x = 16 * math.sin(th) ** 3
        y = 13 * math.cos(th) - 5 * math.cos(2 * th) - 2 * math.cos(3 * th) - math.cos(4 * th)
        pts.append((cx + x * s / 16, cy - y * s / 16))
    d.polygon([(x + 4, y + 6) for x, y in pts], fill=rgba(darker(color, 0.4), a))
    d.polygon(pts, fill=rgba(color, a))
    d.ellipse([cx - s * 0.6, cy - s * 0.6, cx - s * 0.25, cy - s * 0.3], fill=rgba(lighter(color, 0.6), a * 0.8))


def blood_drop(d, cx, cy, s, a=1.0):
    if a <= 0.02:
        return
    d.polygon([(cx, cy - s * 1.5), (cx - s * 0.85, cy), (cx + s * 0.85, cy)], fill=rgba((210, 20, 40), a))
    d.ellipse([cx - s * 0.87, cy - s * 0.8, cx + s * 0.87, cy + s * 0.9], fill=rgba((210, 20, 40), a))
    d.ellipse([cx - s * 0.45, cy - s * 0.4, cx - s * 0.15, cy - s * 0.05], fill=rgba((255, 160, 170), a))


def badge(d, cx, cy, s, a=1.0, color=RED, size=34):
    if a <= 0.02:
        return
    w = len(s) * size * 0.9 + 30
    d.rounded_rectangle([cx - w / 2, cy - size * 0.8, cx + w / 2, cy + size * 0.8], radius=size, fill=rgba(color, a), outline=rgba(WHITE, a), width=3)
    d.text((cx, cy), s, font=font(size), fill=rgba(WHITE, a), anchor="mm")


def bob(t, k=0, amp=10, speed=2.4):
    return amp * math.sin(t * speed + k * 1.3)


# ---------------------------------------------------------------- 3D text / cards
def text3d(d, xy, s, size, color, a=1.0, anchor="mm", depth=None, stroke=None):
    if a <= 0.02:
        return
    size = int(size)
    depth = max(2, size // 16) if depth is None else depth
    stroke = max(2, size // 14) if stroke is None else stroke
    x, y = xy
    f = font(size)
    dc = darker(color, 0.35)
    for i in range(depth, 0, -1):
        d.text((x + i * 0.6, y + i), s, font=f, fill=rgba(dc, a), anchor=anchor,
               stroke_width=stroke, stroke_fill=rgba(dc, a))
    d.text((x, y), s, font=f, fill=rgba(color, a), anchor=anchor,
           stroke_width=stroke, stroke_fill=rgba(NAVY, a))


def label(d, xy, s, size, color=WHITE, a=1.0, anchor="mm"):
    if a <= 0.02:
        return
    d.text(xy, s, font=font(size), fill=rgba(color, a), anchor=anchor,
           stroke_width=max(2, size // 10), stroke_fill=rgba(NAVY, a))


_cards = {}


def card(img, box, a=1.0, color=(60, 80, 170), edge=None):
    """光沢のある立体カード (影・グラデーション・ハイライト付き)."""
    if a <= 0.02:
        return
    x0, y0, x1, y1 = [int(v) for v in box]
    w, h = x1 - x0, y1 - y0
    key = (w, h, color, edge, round(a, 1))
    if key not in _cards:
        if len(_cards) > 120:
            _cards.clear()
        pad = 40
        im = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
        sh = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle([pad + 6, pad + 16, pad + w + 6, pad + h + 16], radius=28, fill=(0, 0, 10, 170))
        sh = sh.filter(ImageFilter.GaussianBlur(12))
        im.alpha_composite(sh)
        # 側面 (厚み)
        body = Image.new("RGBA", im.size, (0, 0, 0, 0))
        bd = ImageDraw.Draw(body)
        bd.rounded_rectangle([pad, pad + 8, pad + w, pad + h + 8], radius=28, fill=darker(color, 0.45) + (255,))
        # 面のグラデーション
        grad = np.linspace(0, 1, h)[:, None]
        top, bot = np.array(lighter(color, 0.25)), np.array(darker(color, 0.8))
        face = (top * (1 - grad) + bot * grad)[:, None, :].repeat(w, 1).reshape(h, w, 3)
        face_img = Image.fromarray(face.astype(np.uint8), "RGB").convert("RGBA")
        mask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=28, fill=255)
        body.paste(face_img, (pad, pad), mask)
        # 上部ハイライト
        hl = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        hd = ImageDraw.Draw(hl)
        hd.rounded_rectangle([6, 4, w - 7, h * 0.45], radius=24, fill=(255, 255, 255, 38))
        body.paste(hl, (pad, pad), Image.composite(hl.getchannel("A"), Image.new("L", (w, h), 0), mask))
        bd.rounded_rectangle([pad, pad, pad + w - 1, pad + h - 1], radius=28,
                             outline=(edge or lighter(color, 0.5)) + (255,), width=4)
        im.alpha_composite(body)
        if a < 1:
            im.putalpha(im.getchannel("A").point(lambda v: int(v * a)))
        _cards[key] = (im, pad)
    im, pad = _cards[key]
    img.paste(im, (x0 - pad, y0 - pad), im)


# ---------------------------------------------------------------- 3D primitives
_balls = {}


def ball(img, cx, cy, r, color, a=1.0):
    r = int(max(3, r))
    key = (r, color, round(a, 1))
    if key not in _balls:
        n = r * 2 + 2
        yy, xx = np.mgrid[0:n, 0:n].astype(np.float32) - r
        dist = np.sqrt(xx ** 2 + yy ** 2) / r
        inside = np.clip((1 - dist) * r, 0, 1)
        nz = np.sqrt(np.clip(1 - dist ** 2, 0, 1))
        light = np.clip((-xx * 0.4 - yy * 0.6) / r * 0.7 + nz * 0.7, 0, 1)
        spec = np.clip((1 - np.sqrt((xx / r + 0.35) ** 2 + (yy / r + 0.4) ** 2) * 3.2), 0, 1) ** 2
        c = np.array(color, np.float32)
        rgb = c * (0.35 + 0.75 * light)[..., None] + 255 * spec[..., None] * 0.8
        out = np.dstack([np.clip(rgb, 0, 255), inside * 255 * a]).astype(np.uint8)
        _balls[key] = Image.fromarray(out, "RGBA")
    im = _balls[key]
    img.paste(im, (int(cx - r - 1), int(cy - r - 1)), im)


def dna3d(img, d, cx, cy, h, w, t=0.0, a=1.0, c1=BLUE, c2=PINK, n=14, horizontal=False):
    """回転する立体DNA (球と棒、奥行きでソート)."""
    if a <= 0.02:
        return
    items = []
    for i in range(n):
        u = i / (n - 1)
        ph = u * 2.6 * math.pi + t * 1.8
        along = -h / 2 + h * u
        p1 = (w / 2 * math.sin(ph), math.cos(ph))
        p2 = (w / 2 * math.sin(ph + math.pi), math.cos(ph + math.pi))
        if horizontal:
            q1 = (cx + along, cy + p1[0])
            q2 = (cx + along, cy + p2[0])
        else:
            q1 = (cx + p1[0], cy + along)
            q2 = (cx + p2[0], cy + along)
        items.append(("rung", (p1[1] + p2[1]) / 2 - 0.01, q1, q2))
        items.append(("ball", p1[1], q1, c1))
        items.append(("ball", p2[1], q2, c2))
    items.sort(key=lambda it: it[1])
    br = max(5, w * 0.11)
    for kind, z, p, q in items:
        if kind == "rung":
            d.line([p, q], fill=rgba((200, 210, 240), a * 0.7), width=max(3, int(br * 0.45)))
        else:
            ball(img, p[0], p[1], br * (0.8 + 0.25 * z), q, a)


def bar3d(d, x, yb, w, h, color, a=1.0, depth=18):
    if a <= 0.02 or h <= 0:
        return
    top = yb - h
    d.polygon([(x, top), (x + depth, top - depth * 0.6), (x + w + depth, top - depth * 0.6), (x + w, top)], fill=rgba(lighter(color, 0.35), a))
    d.polygon([(x + w, top), (x + w + depth, top - depth * 0.6), (x + w + depth, yb - depth * 0.6), (x + w, yb)], fill=rgba(darker(color, 0.6), a))
    d.rectangle([x, top, x + w, yb], fill=rgba(color, a))
    d.line([(x + 3, top + 3), (x + 3, yb - 3)], fill=rgba(lighter(color, 0.5), a * 0.8), width=3)


def hbar3d(d, x, y, w, h, color, a=1.0, depth=14):
    if a <= 0.02 or w <= 0:
        return
    d.polygon([(x, y), (x + depth, y - depth * 0.7), (x + w + depth, y - depth * 0.7), (x + w, y)], fill=rgba(lighter(color, 0.35), a))
    d.polygon([(x + w, y), (x + w + depth, y - depth * 0.7), (x + w + depth, y + h - depth * 0.7), (x + w, y + h)], fill=rgba(darker(color, 0.6), a))
    d.rectangle([x, y, x + w, y + h], fill=rgba(color, a))


def arrow3d(d, p1, p2, color, a=1.0, width=14, head=34):
    if a <= 0.02:
        return
    (x1, y1), (x2, y2) = p1, p2
    ang = math.atan2(y2 - y1, x2 - x1)
    bx, by = x2 - head * math.cos(ang), y2 - head * math.sin(ang)
    px, py = math.cos(ang + math.pi / 2), math.sin(ang + math.pi / 2)
    for off, col in ((5, darker(color, 0.4)), (0, color)):
        hw = width / 2
        body = [(x1 - px * hw + off * .6, y1 - py * hw + off), (bx - px * hw + off * .6, by - py * hw + off),
                (bx + px * hw + off * .6, by + py * hw + off), (x1 + px * hw + off * .6, y1 + py * hw + off)]
        d.polygon(body, fill=rgba(col, a))
        tip = [(x2 + off * .6, y2 + off), (bx + px * head * 0.7 + off * .6, by + py * head * 0.7 + off),
               (bx - px * head * 0.7 + off * .6, by - py * head * 0.7 + off)]
        d.polygon(tip, fill=rgba(col, a))
    d.line([(x1 - px * width * 0.25, y1 - py * width * 0.25), (bx - px * width * 0.25, by - py * width * 0.25)],
           fill=rgba(lighter(color, 0.55), a * 0.8), width=3)


def bob(t, k=0, amp=10, speed=2.4):
    return amp * math.sin(t * speed + k * 1.3)


# ---------------------------------------------------------------- scenes (ずんだもん × 四国めたん 掛け合い版)
# 描画関数 draw(img, d, t, T, L): t=シーン内秒, T=シーン長, L=各セリフの開始秒
ZUN, MET = "zundamon", "metan"
SPEAKERS = {ZUN: dict(id=3, name="ずんだもん", color=(60, 170, 70), dark=(10, 50, 15)),
            MET: dict(id=2, name="四国めたん", color=(220, 70, 140), dark=(70, 10, 40))}


def Lk(L, k, T):
    return L[k] if k < len(L) else T + 99


def option_card(img, d, box, letter, text, a, state=None):
    """クイズの選択肢カード. state: None / 'wrong' / 'right'."""
    col = {None: (50, 70, 150), "wrong": (70, 70, 80), "right": (180, 40, 60)}[state]
    card(img, box, a, col, YELLOW if state == "right" else None)
    x0, y0, x1, y1 = box
    text3d(d, (x0 + 60, (y0 + y1) / 2), letter, 60, YELLOW, a)
    label(d, (x0 + 120, (y0 + y1) / 2), text, 44, WHITE if state != "wrong" else GRAY, a, anchor="lm")


def s_open(img, d, t, T, L):
    photo_bg(img, "lion_bg", t, T, dim=0.35, zoom=(1.0, 1.15), focus=(0.5, 0.4))
    a = appear(t, 0.2)
    seq3d(img, "dna", 170, 300, 460, t, appear(t, 0.4), scale=pop(t, 0.4))
    seq3d(img, "dna", W - 170, 300, 460, t + 2.5, appear(t, 0.6), scale=pop(t, 0.6))
    text3d(d, (W / 2, 190), "生き物は「種を守るため」に", 92, WHITE, a)
    text3d(d, (W / 2, 330), "生きている？", 130, YELLOW, a)
    for i, (k, cap) in enumerate([("lemming", "レミング"), ("bees", "ミツバチ"), ("bat", "チスイコウモリ"), ("cubs", "子ライオン")]):
        polaroid(img, k, 330 + i * 420, 720 + bob(t, i, 6), 330, 220, rot=(-6, 4, -3, 7)[i], scale=pop(t, 0.5 + 0.2 * i), caption=cap)
    stamp_x(d, W / 2 + 440, 320, 115, pop(t, Lk(L, 1, T)))
    if t >= Lk(L, 3, T):
        b = pop(t, Lk(L, 3, T))
        card(img, (260, 420, 1660, 560), appear(t, Lk(L, 3, T)), (170, 30, 50), YELLOW)
        text3d(d, (W / 2, 490), "答え：「自分の遺伝子」を残すため", 66 * max(0.3, b), YELLOW, appear(t, Lk(L, 3, T)))


def s_quiz(img, d, t, T, L):
    photo_bg(img, "lion_family", t, T, dim=0.6, zoom=(1.0, 1.1))
    a = appear(t, 0.2)
    badge(d, 330, 150, "QUIZ", a, RED, 48)
    text3d(d, (W / 2 + 120, 150), "新しいボスのオスが、群れの子に最初にすることは？", 52, WHITE, a)
    polaroid(img, "lion_male", 300, 500, 300, 340, rot=-4, scale=pop(t, 0.4), focus=(0.5, 0.3), caption="新しいボス")
    ans = Lk(L, 2, T)
    opts = [("A", "一緒に遊んであげる"), ("B", "敵から守ってあげる"), ("C", "殺してしまう")]
    for i, (lt, s) in enumerate(opts):
        st = 0.8 + i * 0.4
        state = None
        if t >= ans:
            state = "right" if lt == "C" else "wrong"
        option_card(img, d, (640, 300 + i * 150, 1700, 410 + i * 150), lt, s, appear(t, st), state)
    if t >= Lk(L, 1, T):
        badge(d, 1800, 450, "ずんだもん", appear(t, Lk(L, 1, T)), SPEAKERS[ZUN]["color"], 26)
    if t >= ans:
        text3d(d, (1580, 610), "正解！", 60, RED, pop(t, ans))
    if t >= Lk(L, 4, T):
        card(img, (440, 780, 1480, 870), appear(t, Lk(L, 4, T)), (120, 80, 20), YELLOW)
        label(d, (960, 825), "この謎は、動画の後半でスッキリ解けます", 40, YELLOW, appear(t, Lk(L, 4, T)))


def s_belief(img, d, t, T, L):
    photo_bg(img, "herd", t, T, dim=0.4, zoom=(1.05, 1.2), pan=(0.4, 0))
    a = appear(t, 0.2)
    text3d(d, (W / 2, 110), "昔の常識「種の存続のため」", 70, WHITE, a)
    card(img, (120, 230, 980, 340), a, (120, 80, 20), YELLOW)
    label(d, (550, 285), "「群選択」… 1960年代に広まった考え方", 40, YELLOW, a)
    polaroid(img, "herd2", 1450, 430, 560, 340, rot=4, scale=pop(t, 0.6), caption="ヌーの大移動")
    if t >= Lk(L, 1, T):
        b = appear(t, Lk(L, 1, T))
        card(img, (120, 400, 980, 640), b, (120, 60, 30), ORANGE)
        label(d, (550, 465), "仲間が増えすぎたら…", 46, WHITE, b)
        label(d, (550, 540), "みんなのために、", 46, WHITE, b)
        label(d, (550, 605), "子どもを我慢しよう？", 46, ORANGE, b)


def s_lemming(img, d, t, T, L):
    photo_bg(img, "coast", t, T, dim=0.35, zoom=(1.0, 1.12))
    a = appear(t, 0.1)
    text3d(d, (W / 2, 100), "レミングの「集団自殺」伝説", 80, WHITE, a)
    polaroid(img, "lemming", 520, 500, 560, 380, rot=-4, scale=pop(t, 0.3), caption="ノルウェーレミング")
    if t >= Lk(L, 1, T):
        b = appear(t, Lk(L, 1, T))
        card(img, (1000, 260, 1820, 530), b, (150, 30, 50), RED)
        text3d(d, (1410, 330), "実は「演出」！", 72, YELLOW, b)
        label(d, (1410, 415), "1958年 ディズニー映画『白い荒野』の", 34, WHITE, b)
        label(d, (1410, 470), "撮影で作られた場面が広まった", 34, WHITE, b)
    stamp_x(d, 520, 460, 110, pop(t, Lk(L, 2, T)))
    if t >= Lk(L, 3, T):
        c = appear(t, Lk(L, 3, T))
        card(img, (1000, 580, 1820, 690), c, (40, 60, 140))
        label(d, (1410, 635), "本当は：移動中の事故。自分から死ぬ習性はない", 30, YELLOW, c)


def s_cheater(img, d, t, T, L):
    photo_bg(img, "mouse", t, T, dim=0.72, zoom=(1.0, 1.08), blur=True)
    text3d(d, (W / 2, 80), "思考実験：「ズルい個体」が1割いたら？", 64, WHITE, appear(t, 0.1))
    a = appear(t, 0.3)
    card(img, (70, 170, 780, 790), a, (40, 60, 140))
    label(d, (425, 215), "我慢する村：子は1匹ずつ", 34, YELLOW, a)
    for i in range(9):
        x = 210 + (i % 3) * 215
        y = 330 + (i // 3) * 150
        if i == 8 and t >= Lk(L, 1, T):
            roundphoto(img, "mouse", x, y, 66, scale=pop(t, Lk(L, 1, T)), ring=PURPLE, focus=(0.4, 0.6))
            badge(d, x + 40, y - 55, "2匹産む", pop(t, Lk(L, 1, T) + 0.2), PURPLE, 26)
        else:
            roundphoto(img, "mouse", x, y, 58, a, ring=YELLOW, focus=(0.4, 0.6), gray=True)
    label(d, (425, 750), "ズルい性質は子に遺伝すると仮定", 30, GRAY, a)
    st = Lk(L, 3, T)
    if t >= st:
        c = appear(t, st)
        span = max(2.0, Lk(L, 4, T) - st)
        m = seq_meta("bars")
        tb = clamp((t - st - 0.2) / (span * 0.9)) * m["seconds"]
        r = seq3d(img, "bars", 1370, 545, 470, tb, c)
        label(d, (1370, 815), "世代 →", 34, WHITE, c)
        if r:
            f, left, top, i = r
            p = 0.1
            for g, (x, y, e, bx, by) in enumerate(m["data"][i]):
                hl = g in (3, 7)
                if e > 0.25:
                    label(d, (left + x * f, top + y * f - 8), f"{p * 100:.0f}%", 36 if hl else 30, RED if hl else WHITE, clamp(e))
                label(d, (left + bx * f, top + by * f + 22), f"{g}", 26, GRAY, c)
                p = 2 * p / (2 * p + (1 - p))
    if t >= Lk(L, 4, T):
        card(img, (900, 130, 1840, 200), appear(t, Lk(L, 4, T)), (170, 30, 50), YELLOW)
        label(d, (1370, 165), "3世代で約5割、7世代で9割超え！", 34, YELLOW, appear(t, Lk(L, 4, T)))
    if t >= Lk(L, 6, T):
        text3d(d, (W / 2, 850), "→「種のために我慢する性質」は すぐ消える", 56, YELLOW, appear(t, Lk(L, 6, T)))


def s_gene(img, d, t, T, L):
    photo_bg(img, "dna", t, T, dim=0.45, zoom=(1.0, 1.18))
    text3d(d, (W / 2, 80), "発想の転換：遺伝子の目線で見る", 70, WHITE, appear(t, 0.1))
    polaroid(img, "dawkins", 260, 420, 280, 360, rot=-3, scale=pop(t, 0.3), focus=(0.5, 0.2), caption="R.ドーキンス")
    card(img, (90, 650, 430, 760), appear(t, 0.5), (170, 30, 50), RED)
    label(d, (260, 705), "『利己的な遺伝子』1976", 30, WHITE, appear(t, 0.5))
    k = Lk(L, 2, T)
    if t >= k:
        seq3d(img, "dna", 640, 420, 430, t, appear(t, k), scale=pop(t, k))
        label(d, (640, 650), "設計図＝遺伝子", 36, PINK, appear(t, k))
        arrow3d(d, (720, 430), (830, 430), PINK, appear(t, k + 0.4))
        polaroid(img, "lion_rock", 1080, 410, 380, 250, rot=3, scale=pop(t, k + 0.4), caption="体＝使い捨てロボット")
        arrow3d(d, (1290, 430), (1400, 430), PINK, appear(t, k + 1.4))
        polaroid(img, "cubs", 1630, 420, 340, 230, rot=-3, scale=pop(t, k + 1.6), caption="次の体へ乗り換え")
        label(d, (1360, 640), "体は壊れても、設計図はコピーされて続いていく", 36, WHITE, appear(t, k + 2.0))
    if t >= Lk(L, 4, T):
        text3d(d, (W / 2, 850), "今いる生き物 ＝「コピー上手な遺伝子」の乗り物", 54, YELLOW, appear(t, Lk(L, 4, T)))


def s_answer(img, d, t, T, L):
    photo_bg(img, "lion_family", t, T, dim=0.55, zoom=(1.1, 1.0))
    text3d(d, (W / 2, 80), "クイズの答え合わせ：ライオンの子殺し", 66, WHITE, appear(t, 0.1))
    polaroid(img, "lion_male", 270, 400, 280, 320, rot=-4, scale=pop(t, 0.3), focus=(0.5, 0.3), caption="新しいオス")
    k1 = Lk(L, 1, T)
    if t >= k1:
        arrow3d(d, (430, 400), (540, 400), RED, appear(t, k1))
        polaroid(img, "cubs", 770, 410, 360, 240, rot=3, scale=pop(t, k1), caption="前のオスの子")
        stamp_x(d, 770, 390, 95, pop(t, k1 + 0.8))
        arrow3d(d, (990, 400), (1080, 400), YELLOW, appear(t, k1 + 1.2))
        polaroid(img, "lioness", 1300, 390, 340, 220, rot=-3, scale=pop(t, k1 + 1.2), caption="メスが再び妊娠可能に")
    k2 = Lk(L, 2, T)
    if t >= k2:
        heart(d, 1450, 290, 40, pop(t, k2))
        polaroid(img, "cubs2", 1680, 450, 240, 180, rot=6, scale=pop(t, k2 + 0.5), caption="自分の子")
    if t >= Lk(L, 3, T):
        e = appear(t, Lk(L, 3, T))
        card(img, (300, 680, 1620, 850), e, (60, 40, 110))
        label(d, (W / 2, 728), "種にとって：子どもが減る ×", 46, RED, e)
        label(d, (W / 2, 800), "オスの遺伝子にとって：自分のコピーが早く増える ○", 44, GREEN, e)


def s_puzzle(img, d, t, T, L):
    photo_bg(img, "bees", t, T, dim=0.4, zoom=(1.0, 1.25), focus=(0.55, 0.4))
    seq3d(img, "honeycomb", W / 2, 560, 700, t, appear(t, 0.2), scale=pop(t, 0.2))
    text3d(d, (W / 2, 90), "でも、自分を犠牲にする生き物もいる？", 66, WHITE, appear(t, 0.1))
    polaroid(img, "bees2", 560, 440, 560, 360, rot=-4, scale=pop(t, 0.4), caption="子を産まずに働く 働きバチ")
    polaroid(img, "meerkats", 1380, 440, 300, 380, rot=4, scale=pop(t, 0.9), focus=(0.5, 0.3), caption="見張り役")
    if t >= Lk(L, 1, T):
        text3d(d, (1720, 260), "？", 220, RED, pop(t, Lk(L, 1, T)), depth=12)
        text3d(d, (W / 2, 840), "ここが理論のいちばん面白いところ", 60, YELLOW, appear(t, Lk(L, 1, T)))


def s_hamilton(img, d, t, T, L):
    photo_bg(img, "family", t, T, dim=0.7, zoom=(1.0, 1.1), blur=True)
    text3d(d, (W / 2, 80), "血縁選択（ハミルトン則, 1964）", 62, WHITE, appear(t, 0.1))
    k = Lk(L, 1, T)
    if t >= k:
        text3d(d, (W / 2, 260), "r × B ＞ C", 170, YELLOW, appear(t, k), depth=14)
        items = [("r", "family", "血縁度", "同じ遺伝子を持つ確率", PINK),
                 ("B", "chicks", "相手の得", "相手が増やせる子の数", GREEN),
                 ("C", "lemming2", "自分の損", "自分が失う子の数", RED)]
        for i, (sym, key, h, s, col) in enumerate(items):
            b = appear(t, k + i * 0.7)
            x = 380 + i * 580
            card(img, (x - 260, 420, x + 260, 700), b, darker(col, 0.5), col)
            roundphoto(img, key, x - 150, 505, 60, scale=pop(t, k + i * 0.7), ring=col)
            text3d(d, (x + 60, 505), sym, 96, col, b)
            label(d, (x, 605), h, 46, WHITE, b)
            label(d, (x, 665), s, 30, GRAY, b)
    if t >= Lk(L, 3, T):
        card(img, (260, 740, 1660, 870), appear(t, Lk(L, 3, T)), (110, 80, 20), YELLOW)
        label(d, (W / 2, 780), "家族を助ける ＝ 家族の中にある", 40, WHITE, appear(t, Lk(L, 3, T)))
        label(d, (W / 2, 835), "「自分と同じ遺伝子のコピー」を助けている", 44, YELLOW, appear(t, Lk(L, 3, T)))


def s_family(img, d, t, T, L):
    photo_bg(img, "family", t, T, dim=0.68, zoom=(1.0, 1.1))
    text3d(d, (W / 2, 70), "血縁度 r ＝ 同じ遺伝子を持っている確率", 58, WHITE, appear(t, 0.1))
    me = (W / 2, 420)
    nodes = [("親", "親", (W / 2, 200), "1/2", ORANGE), ("きょうだい", "兄", (W / 2 - 540, 400), "1/2", GREEN),
             ("子", "子", (W / 2, 640), "1/2", PINK), ("いとこ", "従", (W / 2 - 540, 640), "1/8", GRAY),
             ("孫", "孫", (W / 2 + 540, 640), "1/4", PURPLE), ("赤の他人", "他", (W / 2 + 540, 240), "ほぼ 0", (140, 140, 160))]
    for i, (name, ch, (x, y), r, col) in enumerate(nodes):
        b = appear(t, 0.6 + i * 0.5)
        d.line([(me[0] + 4, me[1] + 8), (x + 4, y + 8)], fill=rgba(darker(col, 0.4), b), width=12)
        d.line([me, (x, y)], fill=rgba(col, b), width=10)
    for i, (name, ch, (x, y), r, col) in enumerate(nodes):
        b = appear(t, 0.6 + i * 0.5)
        ball(img, x, y, 70 * max(0.05, pop(t, 0.6 + i * 0.5)), col, b)
        text3d(d, (x, y), ch, 64, WHITE, b)
        label(d, (x - 95, y), name, 38, WHITE, b, anchor="rm")
        text3d(d, (x + 95, y), r, 54, YELLOW, b, anchor="lm")
    ball(img, me[0], me[1], 90 * max(0.05, pop(t, 0.3)), BLUE, appear(t, 0.3))
    text3d(d, me, "自分", 52, WHITE, appear(t, 0.3))
    if t >= Lk(L, 2, T):
        c = appear(t, Lk(L, 2, T))
        card(img, (200, 725, 1720, 880), c, (110, 80, 20), YELLOW)
        label(d, (W / 2, 775), "「兄弟2人か、いとこ8人のためなら命を捨てる」", 46, YELLOW, c)
        label(d, (W / 2, 842), "― J.B.S.ホールデン（とされる冗談）　1/2×2 ＝ 1/8×8 ＝ 1人分", 30, WHITE, c)


def s_bee(img, d, t, T, L):
    photo_bg(img, "queen", t, T, dim=0.6, zoom=(1.0, 1.15), blur=True)
    text3d(d, (W / 2, 70), "ハチが自分で産まない理由（の一つの説）", 58, WHITE, appear(t, 0.1))
    polaroid(img, "queen", 380, 290, 380, 240, rot=-3, scale=pop(t, 0.3), focus=(0.5, 0.45), caption="女王（メス）")
    seq3d(img, "chromo2", 380, 545, 150, t, appear(t, 0.6), scale=pop(t, 0.6))
    label(d, (380, 625), "染色体 2セット", 34, PINK, appear(t, 0.6))
    card(img, (1150, 170, 1700, 270), appear(t, 0.8), (80, 70, 50), (200, 170, 110))
    label(d, (1425, 220), "オス", 44, WHITE, appear(t, 0.8))
    seq3d(img, "chromo1", 1425, 360, 150, t, appear(t, 0.9), scale=pop(t, 0.9))
    label(d, (1425, 440), "染色体 1セットだけ", 34, BLUE, appear(t, 0.9))
    polaroid(img, "bees2", 900, 420, 300, 190, rot=4, scale=pop(t, 1.2), caption="働きバチ（姉妹）")
    k = Lk(L, 1, T)
    if t >= k:
        b = appear(t, k)
        gx, gy = 330, 660
        label(d, (gx, gy + 28), "姉妹との血縁度", 40, WHITE, b, anchor="lm")
        hbar3d(d, gx + 360, gy, 900 * 0.75 * b, 56, GREEN, b)
        text3d(d, (gx + 400 + 900 * 0.75 * b, gy + 28), "3/4", 54, GREEN, b, anchor="lm")
        c = appear(t, k + 1.0)
        label(d, (gx, gy + 118), "自分の子との血縁度", 40, WHITE, c, anchor="lm")
        hbar3d(d, gx + 360, gy + 90, 900 * 0.5 * c, 56, PINK, c)
        text3d(d, (gx + 400 + 900 * 0.5 * c, gy + 118), "1/2", 54, PINK, c, anchor="lm")
    if t >= Lk(L, 3, T):
        label(d, (W / 2, 855), "※ 現在は「巣の環境」など他の要因も重要と考えられています", 34, GRAY, appear(t, Lk(L, 3, T)))


def s_bat(img, d, t, T, L):
    photo_bg(img, "bat", t, T, dim=0.72, zoom=(1.0, 1.1), blur=True)
    text3d(d, (W / 2, 80), "血のつながりがなくても助け合う？", 62, WHITE, appear(t, 0.1))
    k = Lk(L, 1, T)
    polaroid(img, "bat", 400, 380, 440, 290, rot=-4, scale=pop(t, k), caption="血を吸えたコウモリ")
    polaroid(img, "bat2", 1520, 380, 440, 290, rot=4, scale=pop(t, k + 0.3), gray=True, caption="吸えなかったコウモリ")
    if t >= k:
        b = appear(t, k + 0.6)
        arrow3d(d, (680, 330), (1240, 330), RED, b)
        x = 700 + ((t - k) * 260) % 520
        blood_drop(d, x, 275, 22, b)
        label(d, (960, 210), "血を吐き戻して分ける", 36, PINK, b)
    k2 = Lk(L, 2, T)
    if t >= k2:
        c = appear(t, k2)
        arrow3d(d, (1240, 450), (680, 450), GREEN, c)
        label(d, (960, 500), "次は お返しされやすい", 36, GREEN, c)
        card(img, (360, 600, 1560, 770), c, (30, 100, 80), GREEN)
        label(d, (W / 2, 650), "互恵的利他行動（トリヴァース, 1971）", 46, GREEN, c)
        label(d, (W / 2, 720), "「お互いさま」は長い目で見て遺伝子の得になる", 34, WHITE, c)


def s_daily(img, d, t, T, L):
    photo_bg(img, "family", t, T, dim=0.5, zoom=(1.0, 1.12), focus=(0.5, 0.3))
    text3d(d, (W / 2, 80), "身近なことも「遺伝子の目線」で見ると…", 62, WHITE, appear(t, 0.1))
    k = Lk(L, 1, T)
    if t >= k:
        for i, (s, s2) in enumerate([("親が子どもに甘い", "→ 自分のコピー（1/2）への投資"), ("おばあちゃんが孫をかわいがる", "→ 自分のコピー（1/4）への投資")]):
            st = k + i * 1.2
            y = 260 + i * 200
            card(img, (300, y - 70, 1620, y + 70), appear(t, st), (30, 100, 80), GREEN)
            check_mark(d, 370, y, 32, pop(t, st))
            label(d, (430, y - 22), s, 46, WHITE, appear(t, st), anchor="lm")
            label(d, (430, y + 34), s2, 36, YELLOW, appear(t, st), anchor="lm")
    if t >= Lk(L, 2, T):
        text3d(d, (W / 2, 720), "お小遣いも遺伝子のしわざ…？", 64, PINK, pop(t, Lk(L, 2, T)))


def s_caution(img, d, t, T, L):
    photo_bg(img, "dna", t, T, dim=0.55, zoom=(1.2, 1.0))
    text3d(d, (W / 2, 90), "！ 誤解しやすいポイント", 72, ORANGE, appear(t, 0.1))
    a = appear(t, 0.3)
    card(img, (200, 190, 1720, 440), a, (110, 60, 20), ORANGE)
    seq3d(img, "dna", 330, 315, 230, t, a)
    label(d, (1030, 280), "遺伝子に「心」や「意志」はない", 54, WHITE, a)
    label(d, (1030, 365), "「利己的」は たとえ話。増えた遺伝子が残った、というだけ", 32, GRAY, a)
    if t >= Lk(L, 1, T):
        b = appear(t, Lk(L, 1, T))
        card(img, (200, 500, 1720, 750), b, (80, 50, 140), PURPLE)
        roundphoto(img, "meerkats", 330, 625, 80, scale=pop(t, Lk(L, 1, T)), ring=PURPLE, focus=(0.5, 0.35))
        label(d, (1030, 590), "「利己的な遺伝子」≠「利己的な性格」", 54, WHITE, b)
        label(d, (1030, 675), "遺伝子が増えるためなら、体は とても協力的にもなる", 34, GRAY, b)
    if t >= Lk(L, 2, T):
        label(d, (W / 2, 845), "※ 集団レベルの選択（マルチレベル選択）は今も研究・議論が続いています", 34, GRAY, appear(t, Lk(L, 2, T)))


def s_human(img, d, t, T, L):
    photo_bg(img, "family", t, T, dim=0.45, zoom=(1.0, 1.12), focus=(0.5, 0.3))
    text3d(d, (W / 2, 80), "人間は 遺伝子のロボット？", 80, WHITE, appear(t, 0.1))
    k = Lk(L, 1, T)
    if t >= k:
        c = appear(t, k)
        card(img, (440, 200, 1720, 420), c, (110, 80, 20), YELLOW)
        polaroid(img, "dawkins", 330, 300, 190, 240, rot=-5, scale=pop(t, k), focus=(0.5, 0.2))
        label(d, (1080, 275), "「この地上で、我々人間だけが", 44, YELLOW, c)
        label(d, (1080, 350), "利己的な自己複製子の専制支配に反逆できる」", 40, YELLOW, c)
    k2 = Lk(L, 2, T)
    if t >= k2:
        for i, s in enumerate(["養子を育てる", "見知らぬ人に寄付", "子を持たない選択"]):
            st = k2 + i * 0.5
            x = 380 + i * 580
            card(img, (x - 250, 520, x + 250, 630), appear(t, st), (30, 100, 80), GREEN)
            check_mark(d, x - 185, 575, 30, pop(t, st))
            label(d, (x + 30, 575), s, 40, WHITE, appear(t, st))
    if t >= Lk(L, 3, T):
        text3d(d, (W / 2, 780), "ずんだ餅を みんなに配る！", 64, GREEN, pop(t, Lk(L, 3, T)))


def s_summary(img, d, t, T, L):
    photo_bg(img, "lion_rock", t, T, dim=0.7, zoom=(1.0, 1.1), blur=True)
    text3d(d, (W / 2, 90), "まとめ", 96, YELLOW, appear(t, 0.1))
    pts = ["生き物は「種のため」に生きているわけではない",
           "残るのは「自分のコピーを増やすのがうまい遺伝子」",
           "助け合いも 血縁選択・お互いさま で説明できる",
           "でも人間は、遺伝子の損得に逆らうこともできる"]
    for i, s in enumerate(pts):
        st = 0.4 + i * 0.9
        a = appear(t, st)
        y = 230 + i * 125
        card(img, (200, y - 50, 1720, y + 50), a, (50, 70, 150))
        check_mark(d, 270, y, 30, pop(t, st))
        label(d, (330, y), s, 42, WHITE, a, anchor="lm")
    if t >= Lk(L, 2, T):
        c = pop(t, Lk(L, 2, T))
        card(img, (380, 740, 1540, 870), appear(t, Lk(L, 2, T)), (60, 140, 70), WHITE)
        text3d(d, (W / 2, 805), "遺伝子に逆らってやりたいこと、コメントで教えてね！", 44 * max(0.4, c), WHITE, appear(t, Lk(L, 2, T)))


def _credit_lines():
    p = os.path.join(PHOTOS, "credits.json")
    if not os.path.exists(p):
        return []
    c = json.load(open(p, encoding="utf-8"))
    seen = {}
    for k in sorted(c):
        v = c[k]
        seen.setdefault((v["author"], v["license"]), 0)
        seen[(v["author"], v["license"])] += 1
    return [f"{a}（{lic}）" + (f" ×{n}" if n > 1 else "") for (a, lic), n in seen.items()]


CREDIT_LINES = None


def s_credit(img, d, t, T, L):
    global CREDIT_LINES
    if CREDIT_LINES is None:
        CREDIT_LINES = _credit_lines()
    a = appear(t, 0.1)
    text3d(d, (W / 2, 80), "ご視聴ありがとうございました！", 70, YELLOW, a)
    card(img, (120, 150, 1800, 900), a, (30, 40, 90))
    label(d, (W / 2, 200), f"音声：{CREDIT_VOICE}　／　参考：R.ドーキンス『利己的な遺伝子』ほか", 32, WHITE, a)
    label(d, (W / 2, 255), "写真：Wikimedia Commons（一部トリミング・加工）　撮影者とライセンス：", 30, GRAY, a)
    half = (len(CREDIT_LINES) + 1) // 2
    for i, s in enumerate(CREDIT_LINES):
        col, row = divmod(i, half)
        label(d, (180 + col * 820, 310 + row * 44), s, 26, WHITE, a, anchor="lm")
    label(d, (W / 2, 870), "各写真の出典URLとライセンス全文へのリンクは概要欄に記載", 24, GRAY, a)


Z, M = ZUN, MET
# (章タイトル, [(話者, 字幕, 読み上げ用テキスト or None), ...], 描画関数)
SCENES = [
    ("オープニング", [
        (Z, "めたん！動物ってえらいのだ。みんな「種を守るため」に生きてるのだ！", None),
        (M, "あら、ずんだもん。それ、今の生物学では「まちがい」とされていますのよ。", None),
        (Z, "えっ！？じゃあ何のために生きてるのだ？", None),
        (M, "答えは「自分の遺伝子を残すため」。今日はこの「利己的な遺伝子」の話を、とことん深掘りしますわ。", None),
    ], s_open),
    ("クイズ", [
        (M, "まずはクイズですわ。群れの新しいボスになったオスライオンが、群れの子どもたちに最初にすることは？", None),
        (Z, "ボスなんだから、Bの「守ってあげる」に決まってるのだ！", None),
        (M, "残念。正解はC。前のオスの子どもを、殺してしまうことがあるんですの。", None),
        (Z, "ひどすぎるのだ…！種のためどころか、仲間を減らしてるのだ！", None),
        (M, "この謎は、動画の後半でスッキリ解けますわよ。", None),
    ], s_quiz),
    ("昔の常識", [
        (M, "かつては、生き物は「種のため」に行動すると考えられていましたの。1960年代に広まった「群選択」という考え方ですわ。", None),
        (Z, "増えすぎたら、みんなのために子どもを我慢する…みたいな感じなのだ？", None),
        (M, "その通り。その代表例として有名なのが、「レミングの集団自殺」ですわ。", None),
    ], s_belief),
    ("レミング伝説", [
        (Z, "知ってるのだ！増えすぎたレミングが、崖から海に飛び込むやつなのだ！", None),
        (M, "実はそれ、1958年のディズニー映画『白い荒野』の撮影で作られた「演出」が広まったものなんですの。", None),
        (Z, "ヤラセだったのだ！？", None),
        (M, "本物のレミングは、移動中に事故で落ちることはあっても、自分から死にに行く習性はありませんわ。", None),
    ], s_lemming),
    ("思考実験", [
        (M, "そもそも「種のため」説には、致命的な弱点がありますの。みんなが子どもを1匹ずつに我慢している村を考えてみて。", None),
        (M, "そこに、ルール無視で2匹産む「ズルい個体」が1割まざったら、どうなると思います？", None),
        (Z, "1割くらいなら、大したことないのだ。", None),
        (M, "では実際に計算してみましょう。ズルい性質が子に遺伝するとして、世代ごとの割合は…", None),
        (M, "3世代で約5割、7世代で9割を超えますわ。", None),
        (Z, "ズルい方が、あっという間に勝っちゃうのだ…！", None),
        (M, "そう。「種のために我慢する性質」は、自然選択の中ではすぐに消えてしまうんですの。", None),
    ], s_cheater),
    ("遺伝子の目線", [
        (M, "そこで1976年、ドーキンスが『利己的な遺伝子』で広めたのが、「遺伝子の目線」で見る考え方ですわ。", None),
        (Z, "遺伝子の目線…？", None),
        (M, "たとえるなら、体は遺伝子が乗る「使い捨てのロボット」。ロボットは壊れても、設計図である遺伝子はコピーされて、次のロボットに乗り換えていきますの。", None),
        (Z, "ずんだもんの体も、遺伝子の乗り物だったのだ…！", None),
        (M, "何世代もたった後に残っているのは、「コピーを増やすのがうまかった遺伝子」だけ。それが、今いる生き物たちなんですわ。", None),
    ], s_gene),
    ("クイズの答え", [
        (Z, "あっ、じゃあさっきのライオンも…！", None),
        (M, "ええ。子育て中のメスは妊娠しませんが、子を失うと、また妊娠できるようになりますの。", None),
        (M, "新しいオスにとっては、自分の遺伝子を持つ子を早く残せる。だから子殺しの性質が残ってきたと考えられていますわ。", None),
        (Z, "種にはマイナスでも、オスの遺伝子にはプラス。クイズの謎が解けたのだ！", None),
    ], s_answer),
    ("最大のナゾ", [
        (Z, "でも待つのだ。働きバチは自分の子を産まずに、巣のために働くのだ。これこそ「種のため」じゃないのだ？", None),
        (M, "鋭いですわね。実はここが、この理論のいちばん面白いところですの。", None),
    ], s_puzzle),
    ("ハミルトン則", [
        (M, "1964年、ハミルトンは「血縁選択」という考え方を示しました。", None),
        (M, "血縁度r、相手が得る利益B、自分のコストC。rかけるBがCより大きければ、身内を助ける遺伝子は増えていきますの。",
         "血縁度アール、相手が得る利益ビー、自分のコストシー。アールかけるビーがシーより大きければ、身内を助ける遺伝子は増えていきますの。"),
        (Z, "むずかしいのだ…ずんだもんにも分かるように言ってほしいのだ。", None),
        (M, "つまり、家族の中には「自分と同じ遺伝子」が入っている。家族を助けるのは、遺伝子から見れば「自分のコピーを助けている」のと同じなんですの。", None),
    ], s_hamilton),
    ("血縁度", [
        (M, "親子やきょうだいは2分の1、孫は4分の1、いとこは8分の1の確率で、同じ遺伝子を持っていますわ。", None),
        (Z, "ずんだもんにきょうだいがいたら、ずんだ餅好きの遺伝子も、半分の確率で持ってるってことなのだ？", None),
        (M, "たとえとしてはそうですわね。生物学者ホールデンは「兄弟2人か、いとこ8人のためなら命を捨てる」と冗談を言ったとされていますの。", None),
        (Z, "2分の1が2人で1人分、8分の1が8人で1人分…計算が合ってるのだ！", None),
    ], s_family),
    ("ハチの家族", [
        (M, "ハチはもっと特殊ですわ。メスは染色体を2セット、オスは1セットしか持ちませんの。", None),
        (M, "そのせいで、働きバチの姉妹どうしの血縁度は4分の3。自分の子の2分の1より高いんですの。", None),
        (Z, "自分で産むより、妹を育てた方が遺伝子的にお得なのだ！", None),
        (M, "ただし今は、巣の環境など他の要因も大事だと考えられていますわ。これだけで全部は説明できないのも、科学の面白いところですわね。", None),
    ], s_bee),
    ("お互いさま", [
        (Z, "じゃあ、血のつながってない相手は助けないのだ？", None),
        (M, "そうとも限りませんの。チスイコウモリは2、3日血を吸えないと餓死してしまうので、吸えた個体が、仲間に血を吐き戻して分けてあげますの。", None),
        (M, "そして助けてもらった個体は、次にお返しをしやすい。これを「互恵的利他行動」といいますわ。", None),
        (Z, "お互いさまは、長い目で見ると自分の得になるのだ！", None),
    ], s_bat),
    ("身近な例", [
        (M, "この考え方で見ると、身近なことも説明できますのよ。", None),
        (M, "親が子どもに甘いのも、おばあちゃんが孫をかわいがるのも、遺伝子から見ると「自分のコピーへの投資」なんですの。", None),
        (Z, "おばあちゃんがお小遣いをくれるのも、遺伝子のしわざだったのだ…！", None),
        (M, "ふふ、そう言うと、ちょっと夢がありませんけれど。", None),
    ], s_daily),
    ("誤解ポイント", [
        (M, "ただし注意。遺伝子に心や意志があるわけではありませんわ。「利己的」は、あくまでたとえ話。", None),
        (M, "それに「利己的な遺伝子」は「利己的な性格」という意味ではありません。遺伝子が増えるためなら、体はとても協力的にもなりますの。", None),
        (Z, "あと、集団レベルの選択がどこまで働くかは、今も研究が続いてるらしいのだ。", None),
    ], s_caution),
    ("人間は？", [
        (Z, "でも、ずんだもんは遺伝子のロボットってことなのだ…？なんかさびしいのだ。", None),
        (M, "そこがドーキンスの面白いところ。彼は「この地上で、我々人間だけが、利己的な自己複製子の専制支配に反逆できる」と書いていますの。", None),
        (M, "養子を育てたり、見知らぬ人に寄付したり。人間は、遺伝子の損得だけでは動かない生き物なんですわ。", None),
        (Z, "ずんだもんも遺伝子に逆らって、ずんだ餅をみんなに配るのだ！", None),
    ], s_human),
    ("まとめ", [
        (M, "まとめですわ。生き物は種のためではなく、結果として「自分の遺伝子のコピーを残す」ように生きている。助け合いも、血縁選択やお互いさまで説明できますの。", None),
        (M, "でも人間は、それに逆らうこともできる。", None),
        (Z, "みんなは、遺伝子に逆らってやってみたいこと、あるのだ？コメントで教えてほしいのだ！", None),
        (M, "それでは、また次の雑学でお会いしましょう。", None),
    ], s_summary),
    ("クレジット", [], s_credit),
]


# VOICEVOX が読み間違えやすい語の補正 (長い語から順に置換)
READING_FIX = {
    "自己複製子": "じこふくせいし",
    "子殺し": "こごろし",
    "白い荒野": "しろいこうや",
    "2、3日": "にさんにち",
    "種": "しゅ",
}

# ---------------------------------------------------------------- audio (VOICEVOX)
GAP = 0.35
HEAD = 0.6
TAIL = 0.8


def _post(path, params, body=None):
    url = f"{VOICEVOX}{path}?{urllib.parse.urlencode(params)}"
    data = json.dumps(body).encode() if body is not None else b""
    req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def tts(s, spk=None):
    sid = SPEAKERS[spk]["id"] if spk else SPEAKER
    cache = os.path.join(TMP, f"vv_{sid}_{hashlib.md5(s.encode()).hexdigest()[:16]}.wav")
    if not os.path.exists(cache):
        for k in sorted(READING_FIX, key=len, reverse=True):
            s = s.replace(k, READING_FIX[k])
        q = json.loads(_post("/audio_query", {"text": s, "speaker": sid}))
        q.update(speedScale=1.15, intonationScale=1.15, prePhonemeLength=0.05, postPhonemeLength=0.1,
                 outputSamplingRate=SR, outputStereo=False)
        open(cache, "wb").write(_post("/synthesis", {"speaker": sid}, q))
    with wave.open(cache) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
    return x


def build_timeline():
    timeline, voice_chunks, cur = [], [], 0.0
    for si, (title, lines, fn) in enumerate(SCENES):
        t = HEAD
        starts, subs = [], []
        for (spk, sub, reading) in lines:
            x = tts(reading or sub, spk)
            dur = len(x) / SR
            starts.append(t)
            subs.append((sub, cur + t, cur + t + dur, spk))
            voice_chunks.append((cur + t, x))
            t += dur + GAP
        T = (t - GAP + TAIL) if lines else 9.0
        timeline.append((si, cur, T, starts, subs))
        cur += T
        print(f"scene {si:2d} {title}: {T:5.1f}s", flush=True)
    return timeline, voice_chunks, cur


def bgm(total):
    """明るめのポップなループBGM (ベース+コード+ベル+軽いリズム)."""
    n = int(total * SR)
    t = np.arange(n) / SR
    out = np.zeros(n, np.float32)
    bpm = 104
    beat = 60 / bpm
    prog = [(261.63, 329.63, 392.0), (220.0, 261.63, 329.63), (174.61, 220.0, 261.63), (196.0, 246.94, 293.66)]
    bar = beat * 4
    melody = [0, 2, 1, 2, 0, 1, 2, 1]
    for k in range(int(total / bar) + 1):
        ch = prog[k % 4]
        s0 = k * bar
        for b in range(4):
            st = s0 + b * beat
            i0 = int(st * SR)
            if i0 >= n:
                break
            # ベース
            L = min(n - i0, int(beat * 0.9 * SR))
            u = np.arange(L) / SR
            f = ch[0] / 2
            out[i0:i0 + L] += (np.sin(2 * np.pi * f * u) + 0.3 * np.sin(4 * np.pi * f * u)) * np.exp(-u * 3) * 0.09
            # コード (裏拍)
            i1 = int((st + beat / 2) * SR)
            L = min(n - i1, int(beat * 0.4 * SR))
            if L > 0:
                u = np.arange(L) / SR
                for f in ch:
                    out[i1:i1 + L] += np.sin(2 * np.pi * f * u) * np.exp(-u * 9) * 0.03
            # キック/ハット風ノイズ
            L = min(n - i0, int(0.12 * SR))
            u = np.arange(L) / SR
            if b % 2 == 0:
                out[i0:i0 + L] += np.sin(2 * np.pi * (110 * np.exp(-u * 25) + 45) * u) * np.exp(-u * 20) * 0.12
            ih = int((st + beat / 2) * SR)
            Lh = min(n - ih, int(0.04 * SR))
            if Lh > 0:
                out[ih:ih + Lh] += np.random.default_rng(k * 4 + b).normal(0, 1, Lh) * np.exp(-np.arange(Lh) / SR * 90) * 0.02
        # ベルのメロディ
        for j in range(8):
            st = s0 + j * beat / 2
            i0 = int(st * SR)
            if i0 >= n or (j % 4 == 3):
                continue
            f = ch[melody[(j + k) % 8]] * 2
            L = min(n - i0, int(0.5 * SR))
            u = np.arange(L) / SR
            out[i0:i0 + L] += (np.sin(2 * np.pi * f * u) + 0.25 * np.sin(2 * np.pi * f * 3.01 * u)) * np.exp(-u * 6) * 0.03
    fade = np.minimum(1, np.minimum(t / 1.5, (total - t) / 3))
    return out * fade


def build_audio(voice_chunks, total):
    n = int(total * SR) + SR
    voice = np.zeros(n, np.float32)
    for st, x in voice_chunks:
        i = int(st * SR)
        voice[i:i + len(x)] += x[:n - i]
    voice /= max(1e-6, np.abs(voice).max()) / 0.9
    env = np.convolve((np.abs(voice) > 0.02).astype(np.float32), np.ones(SR // 2) / (SR // 2), mode="same")
    music = bgm(n / SR) * (1 - 0.5 * np.clip(env * 3, 0, 1)) * 0.8
    mixed = np.clip(voice + music, -1, 1)
    path = os.path.join(TMP, "audio.wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((mixed * 32767).astype(np.int16).tobytes())
    return path


# ---------------------------------------------------------------- subtitles / chrome
NO_HEAD = "」』、。！？ー…）"


def wrap(s, n):
    out, line = [], ""
    for i, ch in enumerate(s):
        line += ch
        nxt = s[i + 1] if i + 1 < len(s) else ""
        if len(line) >= n and nxt and nxt not in NO_HEAD:
            out.append(line)
            line = ""
    if line:
        if out and len(line) <= 3:
            out[-1] += line
        else:
            out.append(line)
    return out


def sub_page(s, a, b, gt):
    lines = wrap(s, 30)
    pages = [lines[i:i + 2] for i in range(0, len(lines), 2)]
    if len(pages) == 1:
        return pages[0]
    total = sum(len("".join(p)) for p in pages)
    acc = a
    for p in pages:
        acc += (b - a) * len("".join(p)) / total
        if gt < acc:
            return p
    return pages[-1]


SUB_GREEN = (40, 150, 60)  # ずんだもんカラー


def draw_chrome(img, d, si, gt, subs):
    title = SCENES[si][0]
    w = 70 + len(title) * 38
    d.rounded_rectangle([28, 22, 28 + w, 82], radius=16, fill=(255, 214, 64, 255), outline=(120, 80, 0, 255), width=3)
    d.text((28 + w / 2, 52), title, font=font(36), fill=NAVY, anchor="mm")
    label(d, (W - 16, 6), CREDIT_VOICE, 20, (230, 240, 230), 0.85, anchor="rt")
    d.rectangle([0, H - 8, int(W * gt / TOTAL), H], fill=YELLOW)
    cur, spk = None, None
    for (s, a, b, sp) in subs:
        if a - 0.1 <= gt <= b + GAP:
            cur, spk = sub_page(s, a, b, gt), sp
    if cur:
        info = SPEAKERS.get(spk, SPEAKERS[ZUN])
        top = H - 34 - 61 * len(cur)
        nw = len(info["name"]) * 32 + 40
        d.rounded_rectangle([60, top - 52, 60 + nw, top - 6], radius=14, fill=info["color"] + (255,), outline=(255, 255, 255, 255), width=3)
        d.text((60 + nw / 2, top - 29), info["name"], font=font(32), fill=WHITE, anchor="mm")
        for i, ln in enumerate(cur):
            y = top + 30 + i * 61
            d.text((W / 2, y), ln, font=font(50), fill=WHITE, anchor="mm", stroke_width=9, stroke_fill=info["color"])
            d.text((W / 2, y), ln, font=font(50), fill=WHITE, anchor="mm", stroke_width=4, stroke_fill=info["dark"])


def frame(tl, si, gt):
    _, st, T, L, subs = tl[si]
    t = gt - st
    img = BG.copy()
    d = ImageDraw.Draw(img, "RGBA")
    SCENES[si][2](img, d, t, T, L)
    fade = min(1.0, t / 0.3, (T - t) / 0.25 if si < len(tl) - 1 else 1.0)
    if fade < 1.0:
        img = Image.blend(Image.new("RGB", (W, H), (5, 6, 20)), img, max(0.0, fade))
        d = ImageDraw.Draw(img, "RGBA")
    draw_chrome(img, d, si, gt, subs)
    return img


def render(tl, audio_path, total):
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
           "-r", str(FPS), "-i", "-", "-i", audio_path, "-c:v", "libx264", "-preset", "slow", "-crf", "24",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", OUT]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    nframes = int(total * FPS)
    si = 0
    for f in range(nframes):
        gt = f / FPS
        while si < len(tl) - 1 and gt >= tl[si][1] + tl[si][2]:
            si += 1
        p.stdin.write(frame(tl, si, gt).tobytes())
        if f % 600 == 0:
            print(f"frame {f}/{nframes}", flush=True)
    p.stdin.close()
    p.wait()


if __name__ == "__main__":
    tl, vc, TOTAL = build_timeline()
    print(f"total {TOTAL:.1f}s", flush=True)
    ap = build_audio(vc, TOTAL)
    if "--preview" in sys.argv:
        for si, st, T, L, subs in tl:
            frame(tl, si, st + T * 0.93).save(os.path.join(TMP, f"preview_{si:02d}.png"))
        sys.exit(0)
    render(tl, ap, TOTAL)
    print("done:", OUT)
