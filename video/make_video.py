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
CREDIT_VOICE = "VOICEVOX:ずんだもん"
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


# ---------------------------------------------------------------- scenes (写真版)
# 描画関数 draw(img, d, t, T, L): t=シーン内秒, T=シーン長, L=各セリフの開始秒


def s_title(img, d, t, T, L):
    photo_bg(img, "lion_bg", t, T, dim=0.35, zoom=(1.0, 1.15), focus=(0.5, 0.4))
    a = appear(t, 0.2)
    text3d(d, (W / 2, 190), "生き物は「種を守るため」に", 96, WHITE, a)
    text3d(d, (W / 2, 340), "生きている？", 140, YELLOW, a)
    for i, (k, cap) in enumerate([("lemming", "レミング"), ("bees", "ミツバチ"), ("bat", "チスイコウモリ"), ("cubs", "子ライオン")]):
        polaroid(img, k, 330 + i * 420, 720 + bob(t, i, 6), 330, 220, rot=(-6, 4, -3, 7)[i], scale=pop(t, 0.5 + 0.2 * i), caption=cap)
    if len(L) > 1:
        stamp_x(d, W / 2 + 470, 330, 120, pop(t, L[1]))
        text3d(d, (W / 2, 500), "→ 実は ちがう！", 80, RED, appear(t, L[1] + 0.3))


def s_belief(img, d, t, T, L):
    photo_bg(img, "herd", t, T, dim=0.4, zoom=(1.05, 1.2), pan=(0.4, 0))
    a = appear(t, 0.2)
    text3d(d, (W / 2, 110), "よく聞く説明「種の存続のため」", 70, WHITE, a)
    polaroid(img, "herd2", 1450, 430, 560, 340, rot=4, scale=pop(t, 0.6), caption="ヌーの大移動")
    if len(L) > 1:
        b = appear(t, L[1])
        card(img, (120, 300, 980, 560), b, (120, 60, 30), ORANGE)
        label(d, (550, 370), "「仲間が増えすぎたら…", 46, WHITE, b)
        label(d, (550, 440), "みんなのために、", 46, WHITE, b)
        label(d, (550, 505), "自分は子どもを我慢しよう」", 46, ORANGE, b)
    if len(L) > 2:
        card(img, (360, 760, 1560, 850), appear(t, L[2]), (120, 80, 20), YELLOW)
        label(d, (W / 2, 805), "「群選択」… 1960年代に広く信じられた考え方", 46, YELLOW, appear(t, L[2]))


def s_lemming(img, d, t, T, L):
    photo_bg(img, "coast", t, T, dim=0.35, zoom=(1.0, 1.12))
    a = appear(t, 0.1)
    text3d(d, (W / 2, 100), "レミングの「集団自殺」", 84, WHITE, a)
    label(d, (W / 2, 195), "増えすぎた仲間を減らすための自己犠牲？", 48, GRAY, a)
    polaroid(img, "lemming", 520, 520, 560, 380, rot=-4, scale=pop(t, 0.3), caption="ノルウェーレミング")
    if len(L) > 1:
        b = appear(t, L[1])
        card(img, (1000, 290, 1820, 560), b, (150, 30, 50), RED)
        text3d(d, (1410, 360), "実はウソ！", 76, YELLOW, b)
        label(d, (1410, 445), "1958年のディズニー映画『白い荒野』で", 34, WHITE, b)
        label(d, (1410, 500), "撮影用に「演出」された場面が広まった", 34, WHITE, b)
        stamp_x(d, 520, 480, 110, pop(t, L[1] + 0.4))
    if len(L) > 2:
        c = appear(t, L[2])
        card(img, (1000, 610, 1820, 720), c, (40, 60, 140))
        label(d, (1410, 665), "実際は移動中の事故。自分から死ぬ習性はない", 32, YELLOW, c)


def s_cheater(img, d, t, T, L):
    photo_bg(img, "mouse", t, T, dim=0.72, zoom=(1.0, 1.08), blur=True)
    text3d(d, (W / 2, 90), "「種のため」の弱点：ズルい個体", 72, WHITE, appear(t, 0.1))
    a = appear(t, 0.3)
    card(img, (90, 180, 830, 800), a, (40, 60, 140))
    label(d, (460, 750), "我慢する個体（種のため）", 36, YELLOW, a)
    for i in range(9):
        x = 240 + (i % 3) * 220
        y = 330 + (i // 3) * 150
        fx = ((i * 0.13) % 0.6 + 0.2, 0.5)
        if i == 8 and len(L) > 1 and t >= L[1]:
            roundphoto(img, "mouse", x, y, 68, scale=pop(t, L[1]), ring=PURPLE, focus=(0.4, 0.6))
            badge(d, x + 40, y - 55, "ズル", pop(t, L[1] + 0.2), PURPLE, 28)
        else:
            roundphoto(img, "mouse", x, y, 60, a, ring=YELLOW, focus=(0.4, 0.6), gray=True)
    if len(L) > 1:
        label(d, (460, 220), "ズルい個体：遠慮せず たくさん産む", 36, PURPLE, appear(t, L[1]))
    if len(L) > 2:
        c = appear(t, L[2])
        gx, gy, gw, gh = 960, 220, 860, 500
        d.polygon([(gx, gy + gh), (gx + 30, gy + gh - 20), (gx + gw + 30, gy + gh - 20), (gx + gw, gy + gh)], fill=rgba((80, 100, 180), c))
        label(d, (gx + gw / 2, gy + gh + 45), "世代 →", 36, WHITE, c)
        p = 0.1
        n = 10
        bw = gw / n
        span = (L[3] if len(L) > 3 else T) - L[2]
        for g in range(n):
            ba = appear(t, L[2] + 0.4 + g * span * 0.7 / n, 0.35)
            x0 = gx + g * bw + 12
            bh = gh * 0.92 * ba
            bar3d(d, x0, gy + gh, bw - 34, bh * (1 - p), YELLOW, ba, 16)
            bar3d(d, x0, gy + gh - bh * (1 - p), bw - 34, bh * p, PURPLE, ba, 16)
            p = 2 * p / (2 * p + (1 - p))
    if len(L) > 3:
        text3d(d, (W / 2, 850), "→「種のため」の性質は すぐ消える", 60, YELLOW, appear(t, L[3]))


def s_gene(img, d, t, T, L):
    photo_bg(img, "dna", t, T, dim=0.45, zoom=(1.0, 1.18), focus=(0.5, 0.5))
    text3d(d, (W / 2, 90), "遺伝子の目線で見ると…", 76, WHITE, appear(t, 0.1))
    a = appear(t, 0.3)
    polaroid(img, "dawkins", 330, 470, 330, 420, rot=-3, scale=pop(t, 0.3), focus=(0.5, 0.2), caption="R.ドーキンス")
    card(img, (560, 230, 900, 420), a, (170, 30, 50), RED)
    text3d(d, (730, 290), "『利己的な遺伝子』", 34, WHITE, a)
    text3d(d, (730, 365), "1976年", 44, YELLOW, a)
    if len(L) > 1:
        b = appear(t, L[1])
        polaroid(img, "lion_rock", 1300, 470, 470, 300, rot=3, scale=pop(t, L[1]), caption="体 ＝ 乗り物")
        dna3d(img, d, 1700, 480, 380, 120, t, appear(t, L[1] + 0.5))
        arrow3d(d, (1620, 480), (1560, 480), PINK, appear(t, L[1] + 0.8))
        label(d, (1300, 250), "体は 遺伝子を運ぶ「乗り物」", 46, GREEN, b)
        label(d, (1600, 720), "遺伝子 ＝「自己複製子」", 40, PINK, appear(t, L[1] + 0.5))
    if len(L) > 2:
        text3d(d, (W / 2, 840), "残るのは「コピーを残すのがうまい遺伝子」だけ", 56, YELLOW, appear(t, L[2]))


def s_cycle(img, d, t, T, L):
    photo_bg(img, "chicks2", t, T, dim=0.62, zoom=(1.0, 1.1), blur=True)
    text3d(d, (W / 2, 80), "自然選択のしくみ（遺伝子目線）", 64, WHITE, appear(t, 0.1))
    cx, cy, rx, ry = W / 2, 440, 520, 250
    items = [("dna", "遺伝子", "体をつくる", PINK), ("lion_male", "体", "生きのびる", GREEN),
             ("chicks", "繁殖", "子を残す", ORANGE), ("cubs", "コピー", "遺伝子が増える", BLUE)]
    for i, (key, h, s, col) in enumerate(items):
        st = 0.3 + i * 0.9
        a = appear(t, st)
        ang = -math.pi / 2 + i * math.pi / 2
        x, y = cx + rx * math.cos(ang), cy + ry * math.sin(ang)
        card(img, (x - 210, y - 85, x + 210, y + 85), a, darker(col, 0.55), col)
        roundphoto(img, key, x - 125, y, 66, scale=pop(t, st), ring=col, focus=(0.5, 0.35))
        text3d(d, (x + 60, y - 22), h, 50, col, a)
        label(d, (x + 60, y + 36), s, 32, WHITE, a)
        ang2 = ang + math.pi / 2
        x2, y2 = cx + rx * math.cos(ang2), cy + ry * math.sin(ang2)
        b = appear(t, st + 0.6)
        mx, my = (x + x2) / 2, (y + y2) / 2
        arrow3d(d, ((x * 1.6 + mx) / 2.6, (y * 1.6 + my) / 2.6), ((x2 * 1.6 + mx) / 2.6, (y2 * 1.6 + my) / 2.6), WHITE, b, 12, 30)
    dna3d(img, d, cx, cy, 250, 90, t, appear(t, 3.8))
    if len(L) > 1:
        text3d(d, (W / 2, 850), "主役は「体」ではなく、コピーされ続ける「遺伝子」", 52, YELLOW, appear(t, L[1]))


def s_lion(img, d, t, T, L):
    photo_bg(img, "lion_family", t, T, dim=0.55, zoom=(1.0, 1.12))
    text3d(d, (W / 2, 90), "証拠①：ライオンの子殺し", 76, WHITE, appear(t, 0.1))
    polaroid(img, "lion_male", 290, 420, 300, 340, rot=-4, scale=pop(t, 0.3), focus=(0.5, 0.3), caption="新しいオス")
    if len(L) > 1:
        b = appear(t, L[1])
        arrow3d(d, (470, 420), (580, 420), RED, b)
        polaroid(img, "cubs", 820, 430, 380, 250, rot=3, scale=pop(t, L[1]), caption="前のオスの子")
        stamp_x(d, 820, 410, 100, pop(t, L[1] + 0.9))
    if len(L) > 2:
        c = appear(t, L[2])
        arrow3d(d, (1040, 420), (1130, 420), YELLOW, c)
        polaroid(img, "lioness", 1350, 410, 360, 230, rot=-3, scale=pop(t, L[2]), caption="メスが再び妊娠可能に")
        heart(d, 1500, 300, 44, pop(t, L[2] + 0.4))
        polaroid(img, "cubs2", 1700, 470, 240, 180, rot=6, scale=pop(t, L[2] + 0.9), caption="自分の子")
    if len(L) > 3:
        e = appear(t, L[3])
        card(img, (300, 690, 1620, 850), e, (60, 40, 110))
        label(d, (W / 2, 735), "種にとって：子どもが減る ×", 46, RED, e)
        label(d, (W / 2, 805), "オスの遺伝子にとって：自分のコピーが増える ○", 46, GREEN, e)


def s_puzzle(img, d, t, T, L):
    photo_bg(img, "bees", t, T, dim=0.4, zoom=(1.0, 1.25), focus=(0.55, 0.4))
    text3d(d, (W / 2, 90), "でも、助け合う生き物もいるよね？", 70, WHITE, appear(t, 0.1))
    polaroid(img, "bees2", 520, 420, 520, 340, rot=-4, scale=pop(t, 0.4), caption="働きバチ")
    polaroid(img, "meerkats", 1400, 420, 300, 380, rot=4, scale=pop(t, 0.8), focus=(0.5, 0.3), caption="見張り役のミーアキャット")
    if len(L) > 1:
        b = appear(t, L[1])
        card(img, (220, 660, 1700, 760), b, (50, 70, 150))
        label(d, (W / 2, 710), "働きバチは一生 子どもを産まず、巣のために働き、敵を刺して死ぬことも", 38, WHITE, b)
    if len(L) > 2:
        c = appear(t, L[2])
        text3d(d, (W / 2, 840), "「利己的な遺伝子」で説明できる？", 66, YELLOW, c)
        text3d(d, (1720, 260), "？", 220, RED, pop(t, L[2]), depth=12)


def s_hamilton(img, d, t, T, L):
    photo_bg(img, "family", t, T, dim=0.7, zoom=(1.0, 1.1), blur=True)
    text3d(d, (W / 2, 80), "答え：血縁選択（ハミルトン則, 1964）", 62, WHITE, appear(t, 0.1))
    a = appear(t, 0.4)
    text3d(d, (W / 2, 280), "r × B ＞ C", 180, YELLOW, a, depth=14)
    if len(L) > 1:
        items = [("r", "family", "血縁度", "同じ遺伝子を持つ確率", PINK),
                 ("B", "chicks", "相手の得", "相手が増やせる子の数", GREEN),
                 ("C", "lemming2", "自分の損", "自分が失う子の数", RED)]
        for i, (sym, key, h, s, col) in enumerate(items):
            b = appear(t, L[1] + i * 0.8)
            x = 380 + i * 580
            card(img, (x - 260, 450, x + 260, 760), b, darker(col, 0.5), col)
            roundphoto(img, key, x - 150, 540, 62, scale=pop(t, L[1] + i * 0.8), ring=col)
            text3d(d, (x + 60, 540), sym, 100, col, b)
            label(d, (x, 650), h, 48, WHITE, b)
            label(d, (x, 715), s, 30, GRAY, b)
    if len(L) > 2:
        text3d(d, (W / 2, 845), "満たすとき、助ける遺伝子は増えていく", 58, YELLOW, appear(t, L[2]))


def s_family(img, d, t, T, L):
    photo_bg(img, "family", t, T, dim=0.68, zoom=(1.0, 1.1))
    text3d(d, (W / 2, 70), "血縁度 r ＝ 同じ遺伝子を持っている確率", 58, WHITE, appear(t, 0.1))
    me = (W / 2, 420)
    nodes = [
        ("親", "親", (W / 2, 200), "1/2", ORANGE),
        ("きょうだい", "兄", (W / 2 - 540, 400), "1/2", GREEN),
        ("子", "子", (W / 2, 640), "1/2", PINK),
        ("いとこ", "従", (W / 2 - 540, 640), "1/8", GRAY),
        ("孫", "孫", (W / 2 + 540, 640), "1/4", PURPLE),
        ("赤の他人", "他", (W / 2 + 540, 240), "ほぼ 0", (140, 140, 160)),
    ]
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
    if len(L) > 1:
        c = appear(t, L[1])
        card(img, (200, 725, 1720, 880), c, (110, 80, 20), YELLOW)
        label(d, (W / 2, 775), "「兄弟2人か、いとこ8人のためなら命を捨てる」", 46, YELLOW, c)
        label(d, (W / 2, 842), "― J.B.S.ホールデン（とされる冗談）　1/2×2 ＝ 1/8×8 ＝ 1人分", 30, WHITE, c)


def s_bee(img, d, t, T, L):
    photo_bg(img, "queen", t, T, dim=0.6, zoom=(1.0, 1.15), blur=True)
    text3d(d, (W / 2, 70), "ハチが自分で産まない理由（の一つの説）", 58, WHITE, appear(t, 0.1))
    a = appear(t, 0.3)
    polaroid(img, "queen", 470, 330, 420, 280, rot=-3, scale=pop(t, 0.3), focus=(0.5, 0.45), caption="女王（染色体2セット）")
    card(img, (1150, 210, 1700, 330), appear(t, 0.6), (80, 70, 50), (200, 170, 110))
    label(d, (1425, 270), "オス（染色体1セットだけ）", 40, WHITE, appear(t, 0.6))
    polaroid(img, "bees2", 1425, 500, 340, 200, rot=4, scale=pop(t, 0.9), caption="働きバチ（姉妹）")
    if len(L) > 1:
        b = appear(t, L[1])
        gx, gy = 330, 660
        label(d, (gx, gy + 28), "姉妹との血縁度", 40, WHITE, b, anchor="lm")
        hbar3d(d, gx + 360, gy, 900 * 0.75 * b, 56, GREEN, b)
        text3d(d, (gx + 400 + 900 * 0.75 * b, gy + 28), "3/4", 54, GREEN, b, anchor="lm")
        c = appear(t, L[1] + 1.0)
        label(d, (gx, gy + 118), "自分の子との血縁度", 40, WHITE, c, anchor="lm")
        hbar3d(d, gx + 360, gy + 90, 900 * 0.5 * c, 56, PINK, c)
        text3d(d, (gx + 400 + 900 * 0.5 * c, gy + 118), "1/2", 54, PINK, c, anchor="lm")
    if len(L) > 2:
        label(d, (W / 2, 855), "※ 現在は「巣の環境」など他の要因も重要と考えられています", 34, GRAY, appear(t, L[2]))


def s_bat(img, d, t, T, L):
    photo_bg(img, "bat", t, T, dim=0.72, zoom=(1.0, 1.1), blur=True)
    text3d(d, (W / 2, 80), "証拠②：チスイコウモリの血のおすそわけ", 62, WHITE, appear(t, 0.1))
    polaroid(img, "bat", 400, 380, 440, 290, rot=-4, scale=pop(t, 0.3), caption="血を吸えたコウモリ")
    polaroid(img, "bat2", 1520, 380, 440, 290, rot=4, scale=pop(t, 0.5), gray=True, caption="吸えなかったコウモリ")
    if len(L) > 1:
        b = appear(t, L[1])
        arrow3d(d, (680, 330), (1240, 330), RED, b)
        x = 700 + ((t - L[1]) * 260) % 520
        blood_drop(d, x, 275, 22, b)
        label(d, (960, 210), "血を吐き戻して分ける", 36, PINK, b)
    if len(L) > 2:
        c = appear(t, L[2])
        arrow3d(d, (1240, 450), (680, 450), GREEN, c)
        label(d, (960, 500), "次は お返しされやすい", 36, GREEN, c)
        card(img, (360, 600, 1560, 770), c, (30, 100, 80), GREEN)
        label(d, (W / 2, 650), "互恵的利他行動（トリヴァース, 1971）", 46, GREEN, c)
        label(d, (W / 2, 720), "「お互いさま」は長い目で見て遺伝子の得になる", 34, WHITE, c)
    if len(L) > 3:
        text3d(d, (W / 2, 845), "優しさも「遺伝子の損得」で説明できる", 56, YELLOW, appear(t, L[3]))


def s_caution(img, d, t, T, L):
    photo_bg(img, "dna", t, T, dim=0.55, zoom=(1.2, 1.0))
    text3d(d, (W / 2, 90), "！ 注意ポイント", 76, ORANGE, appear(t, 0.1))
    a = appear(t, 0.3)
    card(img, (200, 190, 1720, 440), a, (110, 60, 20), ORANGE)
    dna3d(img, d, 330, 315, 170, 70, t, a)
    label(d, (1030, 280), "遺伝子に「心」や「意志」はない", 54, WHITE, a)
    label(d, (1030, 365), "「利己的」は たとえ話。増えた遺伝子が残った、というだけ", 32, GRAY, a)
    if len(L) > 1:
        b = appear(t, L[1])
        card(img, (200, 500, 1720, 750), b, (80, 50, 140), PURPLE)
        roundphoto(img, "meerkats", 330, 625, 80, scale=pop(t, L[1]), ring=PURPLE, focus=(0.5, 0.35))
        label(d, (1030, 590), "「利己的な遺伝子」≠「利己的な性格」", 54, WHITE, b)
        label(d, (1030, 675), "遺伝子が増えるためなら、体は とても協力的にもなる", 34, GRAY, b)
    if len(L) > 2:
        label(d, (W / 2, 845), "※ 集団レベルの選択（マルチレベル選択）は今も研究・議論が続いています", 34, GRAY, appear(t, L[2]))


def s_human(img, d, t, T, L):
    photo_bg(img, "family", t, T, dim=0.45, zoom=(1.0, 1.12), focus=(0.5, 0.3))
    text3d(d, (W / 2, 80), "じゃあ人間は？", 84, WHITE, appear(t, 0.1))
    if len(L) > 1:
        for i, s in enumerate(["養子を育てる", "見知らぬ人に寄付", "子を持たない選択"]):
            st = L[1] + i * 0.5
            x = 380 + i * 580
            card(img, (x - 250, 470, x + 250, 580), appear(t, st), (30, 100, 80), GREEN)
            check_mark(d, x - 185, 525, 30, pop(t, st))
            label(d, (x + 30, 525), s, 40, WHITE, appear(t, st))
    if len(L) > 2:
        c = appear(t, L[2])
        card(img, (440, 640, 1720, 860), c, (110, 80, 20), YELLOW)
        polaroid(img, "dawkins", 330, 720, 190, 240, rot=-5, scale=pop(t, L[2]), focus=(0.5, 0.2))
        label(d, (1080, 715), "「この地上で、我々人間だけが", 44, YELLOW, c)
        label(d, (1080, 790), "利己的な自己複製子の専制支配に反逆できる」", 40, YELLOW, c)


def s_summary(img, d, t, T, L):
    photo_bg(img, "lion_rock", t, T, dim=0.7, zoom=(1.0, 1.1), blur=True)
    text3d(d, (W / 2, 90), "まとめ", 96, YELLOW, appear(t, 0.1))
    pts = ["生き物は「種のため」に生きているわけではない",
           "残るのは「自分のコピーを増やすのがうまい遺伝子」",
           "助け合いも 血縁選択・お互いさま で説明できる",
           "ただし遺伝子に意志はない。人間は逆らうこともできる"]
    for i, s in enumerate(pts):
        st = 0.4 + i * 0.9
        a = appear(t, st)
        y = 230 + i * 135
        card(img, (200, y - 52, 1720, y + 52), a, (50, 70, 150))
        check_mark(d, 270, y, 32, pop(t, st))
        label(d, (330, y), s, 44, WHITE, a, anchor="lm")
    if len(L) > 1:
        for i, k in enumerate(["lion_male", "bees", "bat", "lemming", "dna"]):
            roundphoto(img, k, 560 + i * 200, 820, 62, scale=pop(t, L[-1] + 0.15 * i), focus=(0.5, 0.4))


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
    label(d, (W / 2, 200), f"音声：{CREDIT_VOICE}　／　参考：R.ドーキンス『利己的な遺伝子』ほか", 34, WHITE, a)
    label(d, (W / 2, 255), "写真：Wikimedia Commons（一部トリミング・加工）　撮影者とライセンス：", 30, GRAY, a)
    half = (len(CREDIT_LINES) + 1) // 2
    for i, s in enumerate(CREDIT_LINES):
        col, row = divmod(i, half)
        label(d, (180 + col * 820, 310 + row * 44), s, 26, WHITE, a, anchor="lm")
    label(d, (W / 2, 870), "CC BY / CC BY-SA の各ライセンス本文は creativecommons.org を参照", 24, GRAY, a)


# (章タイトル, [(字幕, 読み上げ用テキスト or None), ...], 描画関数)
SCENES = [
    ("はじめに", [
        ("「動物は種を守るために生きている」…そう聞いたことはありませんか？", None),
        ("実はこれ、現代の生物学では「まちがい」とされています。", None),
        ("生き物は「自分の遺伝子を残すため」に生きている。今日はその話を深掘りします。", None),
    ], s_title),
    ("昔の考え方", [
        ("かつては、生き物は「種のため」に行動すると考えられていました。", None),
        ("仲間が増えすぎたら、自分が犠牲になって数を調整する…というイメージです。", None),
        ("この考え方は「群選択」と呼ばれ、1960年代には広く信じられていました。", None),
    ], s_belief),
    ("レミングの伝説", [
        ("その代表例が「レミングの集団自殺」。増えすぎると崖から海へ飛び込む、という話です。", None),
        ("でもこれはウソ。1958年のドキュメンタリー映画の演出が広まったものでした。", None),
        ("実際のレミングは、移動中に事故で落ちることはあっても、自分から死にに行く習性はありません。", None),
    ], s_lemming),
    ("種のため説の弱点", [
        ("では「種のため」の考え方の、何がまずいのでしょうか。種のために子どもを控える集団を考えます。", None),
        ("そこに、遠慮せずたくさん子どもを産む「ズルい個体」が一匹だけ現れたら？", None),
        ("ズルい個体の子は、親の性質を受け継いで、またたくさん産みます。世代を重ねるごとに、その割合はどんどん増えていきます。", None),
        ("つまり「種のために我慢する性質」は、自然選択の中ですぐに消えてしまうのです。", None),
    ], s_cheater),
    ("遺伝子の目線", [
        ("そこで登場したのが、1976年のドーキンスの本『利己的な遺伝子』です。", None),
        ("この考え方では、体は遺伝子を運ぶための「乗り物」にすぎません。主役は、自分をコピーし続ける遺伝子です。", None),
        ("何世代もたったあと、生き残っているのは「コピーを残すのがうまかった遺伝子」だけ、というわけです。", None),
    ], s_gene),
    ("自然選択のしくみ", [
        ("遺伝子が体をつくり、体が生きのびて子を残し、遺伝子のコピーが増える。このサイクルが何億年も繰り返されてきました。", None),
        ("体は一代で死にますが、遺伝子はコピーとして次の世代に受け継がれていきます。", None),
    ], s_cycle),
    ("ライオンの子殺し", [
        ("この考え方を裏付ける例が、ライオンの子殺しです。群れを乗っ取った新しいオスは…", None),
        ("前のオスの子どもたちを殺してしまうことがあります。", None),
        ("子育て中のメスは妊娠しませんが、子を失うと再び妊娠できるようになり、新しいオスの子を産むのです。", None),
        ("種にとってはマイナスでも、オスの遺伝子にとってはプラス。「種のため」では説明できない行動です。", None),
    ], s_lion),
    ("助け合いのナゾ", [
        ("でも、ちょっと待ってください。自然界には、他者を助ける生き物もいますよね。", None),
        ("たとえば働きバチは、一生自分の子を産まず、巣のために働き、敵を刺して死ぬこともあります。", None),
        ("これは「自分の遺伝子を残す」と矛盾しないのでしょうか？", None),
    ], s_puzzle),
    ("ハミルトン則", [
        ("その答えが、1964年にハミルトンが示した「血縁選択」です。", None),
        ("血縁度r、相手が得る利益B、自分が払うコストC。", "血縁度アール、相手が得る利益ビー、自分が払うコストシー。"),
        ("rかけるBがCより大きければ、自分を犠牲にしてでも親族を助ける遺伝子は、集団の中で増えていきます。", None),
    ], s_hamilton),
    ("血縁度とは", [
        ("血縁度とは、ある遺伝子を相手も持っている確率のこと。親子やきょうだいは2分の1、いとこは8分の1です。", None),
        ("生物学者ホールデンは「兄弟2人か、いとこ8人のためなら命を捨てる」と冗談を言ったとされています。計算上、自分1人分と同じだからです。", None),
    ], s_family),
    ("ハチの特殊な家族", [
        ("ハチのメスは染色体を2セット、オスは1セットしか持ちません。この特殊な仕組みのせいで…", None),
        ("働きバチどうしの姉妹の血縁度は4分の3。自分で子を産むと2分の1なので、妹を育てるほうが遺伝子的にお得になります。", None),
        ("ただし現在では、これだけでなく、巣の環境など他の要因も重要だと考えられています。", None),
    ], s_bee),
    ("お互いさまの進化", [
        ("血のつながりがなくても助け合う例があります。チスイコウモリです。", None),
        ("彼らは2、3日血を吸えないと餓死してしまうため、たっぷり吸えた個体が、仲間に血を吐き戻して分けてあげます。", None),
        ("そして助けてもらった個体は、次はお返しをしやすい。これを「互恵的利他行動」と言います。", None),
        ("長い目で見れば、お互いさまの関係は、自分の遺伝子にとっても得なのです。", None),
    ], s_bat),
    ("注意ポイント", [
        ("ただし注意。遺伝子に心や意志があるわけではありません。「利己的」はあくまでたとえ話です。", None),
        ("また、利己的な遺伝子は、利己的な性格を意味しません。遺伝子が増えるためなら、体はとても協力的にもなります。", None),
        ("なお、集団レベルでの選択がどこまで働くかは、今も研究と議論が続いているテーマです。", None),
    ], s_caution),
    ("人間の場合", [
        ("では、私たち人間はどうでしょう。私たちの体も、もちろん遺伝子がつくっています。", None),
        ("でも人間は、養子を育てたり、見知らぬ人に寄付したり、子どもを持たない人生を選んだりもします。", None),
        ("ドーキンス自身もこう書いています。「この地上で、我々人間だけが、利己的な自己複製子の専制支配に反逆できる」。", None),
    ], s_human),
    ("まとめ", [
        ("まとめです。生き物は種のためではなく、結果として「自分の遺伝子のコピーを残す」ように生きています。", None),
        ("助け合いや自己犠牲も、血縁選択やお互いさまで説明できる。でも、遺伝子に縛られないのも人間の面白さ。以上、利己的な遺伝子の雑学でした！", None),
    ], s_summary),
    ("クレジット", [], s_credit),
]

# VOICEVOX が読み間違えやすい語の補正 (長い語から順に置換)
READING_FIX = {
    "自己複製子": "じこふくせいし",
    "子殺し": "こごろし",
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


def tts(s):
    cache = os.path.join(TMP, f"vv_{SPEAKER}_{hashlib.md5(s.encode()).hexdigest()[:16]}.wav")
    if not os.path.exists(cache):
        for k in sorted(READING_FIX, key=len, reverse=True):
            s = s.replace(k, READING_FIX[k])
        q = json.loads(_post("/audio_query", {"text": s, "speaker": SPEAKER}))
        q.update(speedScale=1.15, intonationScale=1.15, prePhonemeLength=0.05, postPhonemeLength=0.1,
                 outputSamplingRate=SR, outputStereo=False)
        open(cache, "wb").write(_post("/synthesis", {"speaker": SPEAKER}, q))
    with wave.open(cache) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
    return x


def build_timeline():
    timeline, voice_chunks, cur = [], [], 0.0
    for si, (title, lines, fn) in enumerate(SCENES):
        t = HEAD
        starts, subs = [], []
        for (sub, reading) in lines:
            x = tts(reading or sub)
            dur = len(x) / SR
            starts.append(t)
            subs.append((sub, cur + t, cur + t + dur))
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
    label(d, (W - 30, 46), CREDIT_VOICE, 26, (230, 240, 230), 0.85, anchor="rm")
    d.rectangle([0, H - 8, int(W * gt / TOTAL), H], fill=YELLOW)
    cur = None
    for (s, a, b) in subs:
        if a - 0.1 <= gt <= b + GAP:
            cur = sub_page(s, a, b, gt)
    if cur:
        top = H - 34 - 61 * len(cur)
        for i, ln in enumerate(cur):
            y = top + 30 + i * 61
            d.text((W / 2, y), ln, font=font(50), fill=WHITE, anchor="mm", stroke_width=9, stroke_fill=SUB_GREEN)
            d.text((W / 2, y), ln, font=font(50), fill=WHITE, anchor="mm", stroke_width=4, stroke_fill=(10, 40, 15))


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
           "-r", str(FPS), "-i", "-", "-i", audio_path, "-c:v", "libx264", "-preset", "medium", "-crf", "20",
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
