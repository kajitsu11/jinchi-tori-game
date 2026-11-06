# -*- coding: utf-8 -*-
"""雑学動画「生物は種のためではなく、遺伝子のために生きている」生成スクリプト.

必要: pillow, numpy, pyopenjtalk, ffmpeg
使い方: python3 make_video.py  ->  selfish_gene.mp4
"""
import math
import os
import subprocess
import sys
import wave

import numpy as np
import pyopenjtalk
from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1920, 1080, 30
SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "selfish_gene.mp4")
TMP = os.environ.get("VIDEO_TMP", os.path.join(HERE, "_build"))
os.makedirs(TMP, exist_ok=True)

FONT_PATH = "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf"
_fonts = {}


def font(size):
    if size not in _fonts:
        _fonts[size] = ImageFont.truetype(FONT_PATH, size)
    return _fonts[size]


# ---------------------------------------------------------------- colors
BG_TOP = (14, 22, 48)
BG_BOT = (30, 46, 86)
BG_MID = (22, 34, 67)
WHITE = (245, 247, 252)
YELLOW = (255, 214, 70)
RED = (240, 84, 84)
BLUE = (86, 156, 255)
GREEN = (90, 210, 140)
ORANGE = (255, 150, 60)
GRAY = (150, 160, 185)
PINK = (255, 130, 190)
PURPLE = (175, 130, 255)


def mix(c, a, bg=BG_MID):
    a = max(0.0, min(1.0, a))
    return tuple(int(bg[i] + (c[i] - bg[i]) * a) for i in range(3))


def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def ease(x):
    x = clamp(x)
    return 1 - (1 - x) ** 3


def appear(t, start, dur=0.5):
    return ease((t - start) / dur)


def make_bg():
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        a = y / H
        d.line([(0, y), (W, y)], fill=tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * a) for i in range(3)))
    # うっすらDNA模様
    for x in range(0, W, 6):
        for k, ph in enumerate((0, math.pi)):
            y = 1000 + 30 * math.sin(x / 60 + ph)
            d.ellipse([x - 2, y - 2, x + 2, y + 2], fill=(40, 58, 100))
    return img


BG = make_bg()


# ---------------------------------------------------------------- drawing helpers
def text(d, xy, s, size, color, a=1.0, anchor="mm", stroke=0, stroke_color=(0, 0, 0)):
    if a <= 0:
        return
    d.text(xy, s, font=font(size), fill=mix(color, a), anchor=anchor,
           stroke_width=stroke, stroke_fill=mix(stroke_color, a) if stroke else None)


def creature(d, x, y, r, color, a=1.0, mood="normal"):
    if a <= 0:
        return
    c = mix(color, a)
    d.ellipse([x - r, y - r, x + r, y + r], fill=c, outline=mix(WHITE, a * 0.8), width=int(max(2, r // 12)))
    er = max(2, r // 6)
    for sx in (-1, 1):
        ex, ey = x + sx * r * 0.35, y - r * 0.15
        d.ellipse([ex - er, ey - er, ex + er, ey + er], fill=mix(WHITE, a))
        pr = er * 0.55
        d.ellipse([ex - pr, ey - pr + 1, ex + pr, ey + pr + 1], fill=mix((20, 20, 30), a))
    if mood == "evil":
        for sx in (-1, 1):
            ex = x + sx * r * 0.35
            d.line([ex - sx * er * 1.6, y - r * 0.45, ex + sx * er * 0.6, y - r * 0.28], fill=mix((20, 20, 30), a), width=int(max(2, r // 10)))
        d.arc([x - r * 0.4, y + r * 0.05, x + r * 0.4, y + r * 0.55], 20, 160, fill=mix((20, 20, 30), a), width=int(max(2, r // 10)))
    elif mood == "sad":
        d.arc([x - r * 0.3, y + r * 0.3, x + r * 0.3, y + r * 0.7], 200, 340, fill=mix((20, 20, 30), a), width=int(max(2, r // 12)))
    else:
        d.arc([x - r * 0.3, y + r * 0.05, x + r * 0.3, y + r * 0.45], 20, 160, fill=mix((20, 20, 30), a), width=int(max(2, r // 12)))


def dna(d, cx, cy, h, w, t=0.0, a=1.0, c1=BLUE, c2=PINK):
    if a <= 0:
        return
    n = 10
    pts1, pts2 = [], []
    for i in range(n * 4 + 1):
        yy = cy - h / 2 + h * i / (n * 4)
        ph = i / 4 * 0.9 + t * 2
        pts1.append((cx + w / 2 * math.sin(ph), yy))
        pts2.append((cx + w / 2 * math.sin(ph + math.pi), yy))
    for i in range(0, len(pts1), 4):
        d.line([pts1[i], pts2[i]], fill=mix(GRAY, a * 0.8), width=3)
    d.line(pts1, fill=mix(c1, a), width=6)
    d.line(pts2, fill=mix(c2, a), width=6)


def arrow(d, p1, p2, color, a=1.0, width=6, head=22):
    if a <= 0:
        return
    (x1, y1), (x2, y2) = p1, p2
    ang = math.atan2(y2 - y1, x2 - x1)
    bx, by = x2 - head * math.cos(ang), y2 - head * math.sin(ang)
    d.line([(x1, y1), (bx, by)], fill=mix(color, a), width=width)
    left = (bx + head * 0.6 * math.cos(ang + math.pi / 2), by + head * 0.6 * math.sin(ang + math.pi / 2))
    right = (bx + head * 0.6 * math.cos(ang - math.pi / 2), by + head * 0.6 * math.sin(ang - math.pi / 2))
    d.polygon([(x2, y2), left, right], fill=mix(color, a))


def cross(d, x, y, s, a=1.0, color=RED, width=16):
    if a <= 0:
        return
    s *= ease(a)
    d.line([x - s, y - s, x + s, y + s], fill=mix(color, a), width=width)
    d.line([x - s, y + s, x + s, y - s], fill=mix(color, a), width=width)


def panel(d, box, a=1.0, color=(40, 58, 104), outline=None):
    if a <= 0:
        return
    d.rounded_rectangle(box, radius=24, fill=mix(color, a), outline=mix(outline, a) if outline else None, width=4)


def lion(d, x, y, r, a=1.0, male=True, evil=False):
    if a <= 0:
        return
    if male:
        pts = []
        for i in range(24):
            ang = i / 24 * 2 * math.pi
            rr = r * (1.55 if i % 2 == 0 else 1.25)
            pts.append((x + rr * math.cos(ang), y + rr * math.sin(ang)))
        d.polygon(pts, fill=mix((170, 90, 30), a))
    for sx in (-1, 1):
        ex, ey = x + sx * r * 0.7, y - r * 0.75
        d.ellipse([ex - r * 0.3, ey - r * 0.3, ex + r * 0.3, ey + r * 0.3], fill=mix((230, 170, 70), a))
    creature(d, x, y, r, (240, 185, 80), a, "evil" if evil else "normal")
    d.ellipse([x - r * 0.12, y + r * 0.02, x + r * 0.12, y + r * 0.16], fill=mix((90, 50, 30), a))


def bee(d, x, y, r, a=1.0, color=YELLOW, crown=False, label=None):
    if a <= 0:
        return
    for sx in (-1, 1):
        d.ellipse([x + sx * r * 0.2 - r * 0.45, y - r * 1.25, x + sx * r * 0.2 + r * 0.45, y - r * 0.35], fill=mix((200, 225, 255), a * 0.85))
    d.ellipse([x - r * 1.2, y - r * 0.75, x + r * 1.2, y + r * 0.75], fill=mix(color, a))
    for k in (-0.35, 0.15, 0.6):
        d.line([x + k * r, y - r * 0.68, x + k * r, y + r * 0.68], fill=mix((30, 30, 30), a), width=max(3, int(r * 0.22)))
    d.ellipse([x - r * 0.95, y - r * 0.25, x - r * 0.7, y], fill=mix((20, 20, 30), a))
    if crown:
        cx, cy = x - r * 0.4, y - r * 0.85
        d.polygon([(cx - r * 0.5, cy), (cx - r * 0.5, cy - r * 0.55), (cx - r * 0.25, cy - r * 0.25), (cx, cy - r * 0.65),
                   (cx + r * 0.25, cy - r * 0.25), (cx + r * 0.5, cy - r * 0.55), (cx + r * 0.5, cy)], fill=mix(YELLOW, a), outline=mix(ORANGE, a))
    if label:
        text(d, (x, y + r * 1.25), label, int(r * 0.6), WHITE, a)


def bat(d, x, y, r, a=1.0, color=(130, 110, 160), mood="normal"):
    if a <= 0:
        return
    c = mix(color, a)
    for sx in (-1, 1):
        d.polygon([(x, y - r * 0.2), (x + sx * r * 2.2, y - r * 0.9), (x + sx * r * 1.9, y + r * 0.1),
                   (x + sx * r * 1.4, y - r * 0.15), (x + sx * r * 1.1, y + r * 0.5), (x, y + r * 0.4)], fill=c)
        d.polygon([(x + sx * r * 0.3, y - r * 0.7), (x + sx * r * 0.7, y - r * 1.4), (x + sx * r * 0.75, y - r * 0.5)], fill=c)
    creature(d, x, y, r * 0.85, color, a, mood)


def drop(d, x, y, s, a=1.0):
    if a <= 0:
        return
    d.polygon([(x, y - s * 1.4), (x - s * 0.8, y), (x + s * 0.8, y)], fill=mix((220, 30, 50), a))
    d.ellipse([x - s * 0.82, y - s * 0.8, x + s * 0.82, y + s * 0.84], fill=mix((220, 30, 50), a))


# ---------------------------------------------------------------- scenes
# 各シーン: (章タイトル, [(字幕, 読み or None), ...], 描画関数)
# 描画関数 draw(d, t, T, L): t=シーン内秒, T=シーン長, L=各セリフの開始秒


def s_title(d, t, T, L):
    for i in range(7):
        x = 300 + i * 220
        y = 760 + 18 * math.sin(t * 3 + i)
        creature(d, x, y, 55, [BLUE, GREEN, ORANGE, PINK, PURPLE, YELLOW, BLUE][i], appear(t, 0.1 * i))
    a = appear(t, 0.3)
    text(d, (W / 2, 250), "生き物は「種を守るため」に", 92, WHITE, a, stroke=4)
    text(d, (W / 2, 380), "生きている？", 120, YELLOW, a, stroke=5)
    if len(L) > 1:
        b = appear(t, L[1], 0.35)
        cross(d, W / 2 + 330, 380, 110, b)
        text(d, (W / 2, 540), "→ 実は ちがいます", 70, RED, b, stroke=3)


def s_belief(d, t, T, L):
    # 種のために自己犠牲する、というイメージ
    a = appear(t, 0.2)
    panel(d, (160, 140, 1760, 790), a * 0.6)
    text(d, (W / 2, 210), "よく聞く説明「種の存続のため」", 64, WHITE, a)
    # 大きな「種」の円
    d.ellipse([560, 300, 1360, 720], outline=mix(GREEN, a), width=6)
    text(d, (W / 2, 330), "種（グループ）", 44, GREEN, a)
    for i in range(10):
        ang = i / 10 * 2 * math.pi
        x = W / 2 + 280 * math.cos(ang)
        y = 520 + 130 * math.sin(ang)
        creature(d, x, y, 36, BLUE, a)
    if len(L) > 1:
        b = appear(t, L[1])
        creature(d, W / 2, 520, 50, ORANGE, b, "sad")
        text(d, (W / 2, 755), "まんなかの子：自分は犠牲に…", 40, ORANGE, b)
        for k in range(6):
            ang = k / 6 * 2 * math.pi
            arrow(d, (W / 2 + 70 * math.cos(ang), 520 + 70 * math.sin(ang)),
                  (W / 2 + 170 * math.cos(ang), 520 + 100 * math.sin(ang)), YELLOW, b, 4, 14)
    if len(L) > 2:
        c = appear(t, L[2])
        text(d, (W / 2, 860), "「群選択」… 1960年代に広く信じられた考え方", 50, YELLOW, c, stroke=2)


def s_lemming(d, t, T, L):
    a = appear(t, 0.1)
    # 崖
    d.polygon([(0, 560), (1150, 560), (1150, 900), (0, 900)], fill=mix((70, 100, 70), a))
    d.polygon([(1150, 560), (1150, 900), (1190, 900)], fill=mix((50, 75, 55), a))
    d.rectangle([1150, 820, W, 900], fill=mix((40, 90, 170), a))  # 海
    for i in range(8):
        prog = (t * 140 + i * 130) % 1300
        x = prog - 100
        y = 525
        if x > 1150:
            y = 525 + (x - 1150) ** 1.6 / 6
        if y < 860:
            creature(d, x, y, 32, (200, 150, 100), a)
    text(d, (W / 2, 180), "レミングの「集団自殺」", 80, WHITE, a, stroke=3)
    text(d, (W / 2, 290), "＝ 増えすぎた仲間を減らすための自己犠牲？", 50, WHITE, a)
    if len(L) > 1:
        b = appear(t, L[1])
        panel(d, (1180, 360, 1840, 520), b, (120, 30, 40), RED)
        text(d, (1510, 410), "実はウソ！", 60, YELLOW, b)
        text(d, (1510, 475), "1958年の映画の「演出」が広まった", 32, WHITE, b)
    if len(L) > 2:
        c = appear(t, L[2])
        text(d, (W / 2, 640), "実際は移動中の事故。自分から死ぬ習性はない", 46, YELLOW, c, stroke=3)


def s_cheater(d, t, T, L):
    text(d, (W / 2, 110), "「種のため」の問題点：ズルい個体", 66, WHITE, appear(t, 0.1), stroke=3)
    # 左: 集団
    a = appear(t, 0.3)
    panel(d, (100, 190, 840, 780), a * 0.6)
    for i in range(9):
        x = 230 + (i % 3) * 200
        y = 320 + (i // 3) * 150
        creature(d, x, y, 50, BLUE, a)
    text(d, (470, 740), "青：子どもを控える（種のため）", 34, BLUE, a)
    if len(L) > 1:
        b = appear(t, L[1])
        creature(d, 630, 620, 50, RED, b, "evil")
        text(d, (470, 220), "赤：遠慮せず たくさん産む", 34, RED, b)
    # 右: 世代ごとの割合グラフ
    if len(L) > 2:
        c = appear(t, L[2])
        gx, gy, gw, gh = 980, 230, 820, 520
        d.line([gx, gy + gh, gx + gw, gy + gh], fill=mix(WHITE, c), width=4)
        d.line([gx, gy, gx, gy + gh], fill=mix(WHITE, c), width=4)
        text(d, (gx + gw / 2, gy + gh + 50), "世代 →", 36, WHITE, c)
        text(d, (gx - 40, gy + gh / 2), "割合", 32, WHITE, c)
        p = 0.1
        n = 10
        bw = gw / n
        span = (L[3] if len(L) > 3 else T) - L[2]
        for g in range(n):
            ba = appear(t, L[2] + 0.4 + g * span * 0.7 / n, 0.3)
            if ba > 0:
                x0 = gx + g * bw + 10
                rh = gh * p * ba
                bh = gh * (1 - p) * ba
                d.rectangle([x0, gy + gh - bh, x0 + bw - 20, gy + gh], fill=BLUE)
                d.rectangle([x0, gy + gh - bh - rh, x0 + bw - 20, gy + gh - bh], fill=RED)
            p = 2 * p / (2 * p + (1 - p))
    if len(L) > 3:
        e = appear(t, L[3])
        text(d, (W / 2, 870), "→ 「種のため」の性質は、すぐに消えてしまう", 54, YELLOW, e, stroke=3)


def s_gene(d, t, T, L):
    text(d, (W / 2, 110), "遺伝子の目線で見ると…", 70, WHITE, appear(t, 0.1), stroke=3)
    a = appear(t, 0.3)
    # 左: 本
    panel(d, (120, 230, 560, 760), a, (200, 60, 60))
    text(d, (340, 330), "利己的な", 56, WHITE, a)
    text(d, (340, 400), "遺伝子", 72, WHITE, a)
    dna(d, 340, 560, 200, 90, t, a, WHITE, YELLOW)
    text(d, (340, 710), "R.ドーキンス（1976）", 32, WHITE, a)
    if len(L) > 1:
        # 右: 乗り物の図
        b = appear(t, L[1])
        cx, cy = 1230, 470
        d.rounded_rectangle([cx - 420, cy - 230, cx + 420, cy + 230], radius=200, outline=mix(GREEN, b), width=8)
        text(d, (cx, cy - 270), "体 ＝ 遺伝子の「乗り物」", 50, GREEN, b)
        for k in range(5):
            dna(d, cx - 280 + k * 140, cy + 10 * math.sin(t * 2 + k), 200, 60, t + k, b)
        text(d, (cx, cy + 270), "遺伝子 ＝ 自分をコピーする「自己複製子」", 42, PINK, b)
    if len(L) > 2:
        c = appear(t, L[2])
        text(d, (W / 2, 860), "生き残るのは「コピーを残すのがうまい遺伝子」だけ", 54, YELLOW, c, stroke=3)


def s_cycle(d, t, T, L):
    text(d, (W / 2, 70), "自然選択のしくみ（遺伝子目線）", 60, WHITE, appear(t, 0.1), stroke=3)
    cx, cy, R = W / 2, 470, 270
    items = [("遺伝子", "体をつくる", PINK), ("体", "生きのびる", GREEN), ("繁殖", "子を残す", ORANGE), ("コピー", "遺伝子が増える", BLUE)]
    for i, (h, s, col) in enumerate(items):
        st = L[min(i, len(L) - 1)] if i < len(L) else T
        st = 0.3 + i * 0.9
        a = appear(t, st)
        ang = -math.pi / 2 + i * math.pi / 2
        x, y = cx + R * 1.5 * math.cos(ang), cy + R * math.sin(ang)
        panel(d, (x - 190, y - 80, x + 190, y + 80), a, (40, 58, 104), col)
        text(d, (x, y - 25), h, 50, col, a)
        text(d, (x, y + 35), s, 34, WHITE, a)
        ang2 = ang + math.pi / 2
        x2, y2 = cx + R * 1.5 * math.cos(ang2), cy + R * math.sin(ang2)
        b = appear(t, st + 0.6)
        mx, my = (x + x2) / 2, (y + y2) / 2
        arrow(d, ((x * 2 + mx) / 3, (y * 2 + my) / 3), ((x2 * 2 + mx) / 3, (y2 * 2 + my) / 3), WHITE, b)
    dna(d, cx, cy, 260, 80, t, appear(t, 3.8))
    if len(L) > 1:
        text(d, (W / 2, 880), "主役は「体」ではなく、何世代もコピーされ続ける「遺伝子」", 46, YELLOW, appear(t, L[1]), stroke=3)


def s_lion(d, t, T, L):
    text(d, (W / 2, 100), "証拠①：ライオンの子殺し", 70, WHITE, appear(t, 0.1), stroke=3)
    a = appear(t, 0.3)
    lion(d, 330, 450, 90, a, male=True, evil=True)
    text(d, (330, 640), "群れを乗っ取った新しいオス", 36, WHITE, a)
    if len(L) > 1:
        b = appear(t, L[1])
        arrow(d, (480, 450), (700, 450), RED, b)
        for i in range(3):
            x = 820 + i * 110
            lion(d, x, 470, 42, b, male=False)
            cross(d, x, 470, 50, appear(t, L[1] + 0.8 + 0.3 * i))
        text(d, (930, 580), "前のオスの子", 36, WHITE, b)
    if len(L) > 2:
        c = appear(t, L[2])
        arrow(d, (1120, 450), (1300, 450), YELLOW, c)
        lion(d, 1400, 430, 70, c, male=False)
        text(d, (1400, 560), "メスが再び妊娠可能に", 32, WHITE, c)
        for i in range(2):
            lion(d, 1660 + i * 90, 470, 36, appear(t, L[2] + 0.8), male=False)
        text(d, (1705, 540), "自分の子", 32, YELLOW, appear(t, L[2] + 0.8))
    if len(L) > 3:
        e = appear(t, L[3])
        panel(d, (260, 720, 1660, 880), e, (60, 40, 70))
        text(d, (W / 2, 770), "種にとって：子どもが減る ×", 46, RED, e)
        text(d, (W / 2, 835), "オスの遺伝子にとって：自分のコピーが増える ○", 46, GREEN, e)


def s_puzzle(d, t, T, L):
    text(d, (W / 2, 100), "でも、助け合う生き物もいるよね？", 66, WHITE, appear(t, 0.1), stroke=3)
    a = appear(t, 0.3)
    for i in range(6):
        bee(d, 300 + i * 260, 360 + 20 * math.sin(t * 4 + i), 60, appear(t, 0.3 + 0.15 * i), label="働きバチ")
    if len(L) > 1:
        b = appear(t, L[1])
        text(d, (W / 2, 560), "一生 子どもを産まず、巣のために働き、敵を刺して死ぬことも", 46, WHITE, b)
    if len(L) > 2:
        c = appear(t, L[2])
        text(d, (W / 2, 700), "「利己的な遺伝子」で説明できる？", 64, YELLOW, c, stroke=3)


def s_hamilton(d, t, T, L):
    text(d, (W / 2, 100), "答え：血縁選択（ハミルトン則, 1964）", 62, WHITE, appear(t, 0.1), stroke=3)
    a = appear(t, 0.4)
    text(d, (W / 2, 320), "r × B ＞ C", 170, YELLOW, a, stroke=6)
    if len(L) > 1:
        items = [("r", "血縁度", "相手と同じ遺伝子を持つ確率", PINK),
                 ("B", "相手の得", "相手が増やせる子の数", GREEN),
                 ("C", "自分の損", "自分が失う子の数", RED)]
        for i, (sym, h, s, col) in enumerate(items):
            b = appear(t, L[1] + i * 0.8)
            x = 380 + i * 580
            panel(d, (x - 260, 480, x + 260, 760), b, (40, 58, 104), col)
            text(d, (x, 545), sym, 90, col, b)
            text(d, (x, 640), h, 50, WHITE, b)
            text(d, (x, 710), s, 30, GRAY, b)
    if len(L) > 2:
        c = appear(t, L[2])
        text(d, (W / 2, 860), "これを満たすとき、助ける遺伝子は増えていく", 54, YELLOW, c, stroke=3)


def s_family(d, t, T, L):
    text(d, (W / 2, 90), "血縁度 r ＝ 同じ遺伝子を持っている確率", 60, WHITE, appear(t, 0.1), stroke=3)
    a = appear(t, 0.3)
    me = (W / 2, 430)
    nodes = [
        ("親", (W / 2, 210), "1/2", ORANGE),
        ("きょうだい", (W / 2 - 520, 430), "1/2", GREEN),
        ("子", (W / 2, 640), "1/2", PINK),
        ("いとこ", (W / 2 - 520, 650), "1/8", GRAY),
        ("孫", (W / 2 + 520, 650), "1/4", PURPLE),
        ("赤の他人", (W / 2 + 520, 260), "ほぼ 0", (110, 110, 130)),
    ]
    for i, (name, (x, y), r, col) in enumerate(nodes):
        b = appear(t, 0.6 + i * 0.5)
        d.line([me, (x, y)], fill=mix(col, b * 0.7), width=5)
        creature(d, x, y, 55, col, b)
        text(d, (x - 80, y), name, 38, WHITE, b, anchor="rm", stroke=2)
        text(d, (x + 120, y), r, 50, YELLOW, b, anchor="lm", stroke=2)
    creature(d, me[0], me[1], 75, BLUE, a)
    text(d, (me[0] - 100, me[1] - 70), "自分", 44, BLUE, a, anchor="rm", stroke=2)
    if len(L) > 1:
        c = appear(t, L[1])
        panel(d, (210, 745, 1710, 900), c, (70, 50, 20), YELLOW)
        text(d, (W / 2, 795), "「兄弟2人か、いとこ8人のためなら命を捨てる」", 46, YELLOW, c)
        text(d, (W / 2, 860), "― 生物学者 J.B.S.ホールデン（とされる冗談）　1/2×2 ＝ 1/8×8 ＝ 1", 30, WHITE, c)


def s_bee(d, t, T, L):
    text(d, (W / 2, 90), "ハチが自分で産まない理由（の一つの説）", 60, WHITE, appear(t, 0.1), stroke=3)
    a = appear(t, 0.3)
    bee(d, 600, 250, 70, a, crown=True)
    text(d, (600, 350), "女王（染色体2セット）", 34, WHITE, a)
    bee(d, 1320, 250, 60, a, color=(200, 160, 90))
    text(d, (1320, 350), "オス（1セットだけ）", 34, WHITE, a)
    arrow(d, (700, 390), (880, 470), WHITE, a)
    arrow(d, (1220, 390), (1040, 470), WHITE, a)
    for i in range(3):
        bee(d, 840 + i * 120, 520, 40, a)
    text(d, (960, 590), "働きバチ（姉妹）", 34, WHITE, a)
    if len(L) > 1:
        b = appear(t, L[1])
        gx, gy = 330, 630
        text(d, (gx, gy + 40), "姉妹との血縁度", 40, WHITE, b, anchor="lm")
        d.rectangle([gx + 360, gy + 15, gx + 360 + int(900 * 0.75 * b), gy + 70], fill=GREEN)
        text(d, (gx + 380 + int(900 * 0.75 * b), gy + 42), "3/4", 50, GREEN, b, anchor="lm")
        c = appear(t, L[1] + 1.0)
        text(d, (gx, gy + 130), "自分の子との血縁度", 40, WHITE, c, anchor="lm")
        d.rectangle([gx + 360, gy + 105, gx + 360 + int(900 * 0.5 * c), gy + 160], fill=PINK)
        text(d, (gx + 380 + int(900 * 0.5 * c), gy + 132), "1/2", 50, PINK, c, anchor="lm")
    if len(L) > 2:
        e = appear(t, L[2])
        text(d, (W / 2, 880), "※ 現在は「巣の環境」など他の要因も重要と考えられています", 34, GRAY, e)


def s_bat(d, t, T, L):
    text(d, (W / 2, 90), "証拠②：チスイコウモリの「血のおすそわけ」", 60, WHITE, appear(t, 0.1), stroke=3)
    a = appear(t, 0.3)
    bat(d, 520, 420, 75, a)
    text(d, (520, 560), "血を吸えたコウモリ", 36, WHITE, a)
    bat(d, 1400, 420, 75, a, (110, 100, 140), "sad")
    text(d, (1400, 560), "吸えなかったコウモリ", 36, WHITE, a)
    if len(L) > 1:
        b = appear(t, L[1])
        arrow(d, (700, 380), (1210, 380), RED, b)
        x = 700 + ((t - L[1]) * 300) % 510
        drop(d, x, 340, 22, b)
        text(d, (955, 300), "血を吐き戻して分ける", 36, PINK, b)
    if len(L) > 2:
        c = appear(t, L[2])
        arrow(d, (1210, 480), (700, 480), GREEN, c)
        text(d, (955, 530), "次は お返しされやすい", 36, GREEN, c)
        panel(d, (360, 650, 1560, 820), c, (40, 58, 104), GREEN)
        text(d, (W / 2, 705), "互恵的利他行動（トリヴァース, 1971）", 48, GREEN, c)
        text(d, (W / 2, 770), "「お互いさま」は 長い目で見て自分の遺伝子の得になる", 36, WHITE, c)
    if len(L) > 3:
        text(d, (W / 2, 880), "優しさも「遺伝子の損得」で説明できる", 54, YELLOW, appear(t, L[3]), stroke=3)


def s_caution(d, t, T, L):
    text(d, (W / 2, 100), "！ 注意ポイント", 70, ORANGE, appear(t, 0.1), stroke=3)
    a = appear(t, 0.3)
    panel(d, (200, 200, 1720, 470), a, (40, 58, 104), ORANGE)
    text(d, (W / 2, 270), "遺伝子に「心」や「意志」はない", 58, WHITE, a)
    text(d, (W / 2, 360), "「利己的」は たとえ話。結果的に増えた遺伝子が残った、というだけ", 36, GRAY, a)
    dna(d, 330, 335, 200, 60, t, a)
    if len(L) > 1:
        b = appear(t, L[1])
        panel(d, (200, 530, 1720, 800), b, (40, 58, 104), PURPLE)
        text(d, (W / 2, 600), "「利己的な遺伝子」≠「利己的な性格」", 58, WHITE, b)
        text(d, (W / 2, 690), "遺伝子が増えるためなら、体は とても協力的・利他的にもなる", 36, GRAY, b)
    if len(L) > 2:
        c = appear(t, L[2])
        text(d, (W / 2, 870), "※ 集団レベルの選択（マルチレベル選択）は今も研究・議論が続いています", 34, GRAY, c)


def s_human(d, t, T, L):
    text(d, (W / 2, 100), "じゃあ人間は？", 76, WHITE, appear(t, 0.1), stroke=3)
    a = appear(t, 0.3)
    creature(d, W / 2, 420, 110, BLUE, a)
    for k in range(4):
        ang = -math.pi / 2 + (k - 1.5) * 0.7
        dna(d, W / 2 + 330 * math.cos(ang), 420 + 260 * math.sin(ang) + 120, 120, 40, t + k, a * 0.8)
    if len(L) > 1:
        b = appear(t, L[1])
        for i, s in enumerate(["養子を育てる", "見知らぬ人に寄付する", "子どもを持たない選択"]):
            x = 380 + i * 580
            panel(d, (x - 250, 600, x + 250, 700), appear(t, L[1] + i * 0.5), (40, 58, 104), GREEN)
            text(d, (x, 650), s, 40, WHITE, appear(t, L[1] + i * 0.5))
    if len(L) > 2:
        c = appear(t, L[2])
        text(d, (W / 2, 790), "「この地上で、我々人間だけが", 46, YELLOW, c, stroke=2)
        text(d, (W / 2, 855), "利己的な自己複製子の専制支配に反逆できる」― ドーキンス", 46, YELLOW, c, stroke=2)


def s_summary(d, t, T, L):
    text(d, (W / 2, 110), "まとめ", 86, YELLOW, appear(t, 0.1), stroke=4)
    pts = ["生き物は「種のため」に生きているわけではない",
           "残るのは「自分のコピーを増やすのがうまい遺伝子」",
           "助け合い・自己犠牲も 血縁選択・お互いさま で説明できる",
           "ただし遺伝子に意志はない。人間は それに逆らうこともできる"]
    for i, s in enumerate(pts):
        st = L[min(i, len(L) - 1)] if i < len(L) else 0
        a = appear(t, 0.4 + i * 0.9)
        y = 250 + i * 135
        panel(d, (180, y - 55, 1740, y + 55), a, (40, 58, 104))
        text(d, (240, y), f"{i + 1}", 56, YELLOW, a)
        text(d, (300, y), s, 44, WHITE, a, anchor="lm")
    if len(L) > 1:
        e = appear(t, L[-1])
        for i in range(5):
            creature(d, 560 + i * 200, 820 + 12 * math.sin(t * 4 + i), 45, [BLUE, GREEN, ORANGE, PINK, PURPLE][i], e)


SCENES = [
    ("はじめに", [
        ("「動物は種を守るために生きている」…そう聞いたことはありませんか？", "「どうぶつわ、しゅをまもるためにいきている」。そうきいたことはありませんか？"),
        ("実はこれ、現代の生物学では「まちがい」とされています。", "じつはこれ、げんだいのせいぶつがくでは、まちがいとされています。"),
        ("生き物は「自分の遺伝子を残すため」に生きている。今日はその話を深掘りします。", "いきものは、じぶんのいでんしをのこすためにいきている。きょうは、そのはなしをふかぼりします。"),
    ], s_title),
    ("昔の考え方", [
        ("かつては、生き物は「種のため」に行動すると考えられていました。", "かつては、いきものは、しゅのために、こうどうすると、かんがえられていました。"),
        ("仲間が増えすぎたら、自分が犠牲になって数を調整する…というイメージです。", "なかまがふえすぎたら、じぶんがぎせいになって、かずをちょうせいする、というイメージです。"),
        ("この考え方は「群選択」と呼ばれ、1960年代には広く信じられていました。", "このかんがえかたは、ぐんせんたくとよばれ、せんきゅうひゃくろくじゅうねんだいには、ひろくしんじられていました。"),
    ], s_belief),
    ("レミングの伝説", [
        ("その代表例が「レミングの集団自殺」。増えすぎると崖から海へ飛び込む、という話です。", "そのだいひょうれいが、レミングのしゅうだんじさつ。ふえすぎると、がけからうみへとびこむ、というはなしです。"),
        ("でもこれはウソ。1958年のドキュメンタリー映画の演出が広まったものでした。", "でもこれはウソ。せんきゅうひゃくごじゅうはちねんの、ドキュメンタリーえいがの、えんしゅつが、ひろまったものでした。"),
        ("実際のレミングは、移動中に事故で落ちることはあっても、自分から死にに行く習性はありません。", "じっさいのレミングは、いどうちゅうに、じこでおちることはあっても、じぶんからしににいく、しゅうせいはありません。"),
    ], s_lemming),
    ("種のため説の弱点", [
        ("では「種のため」の考え方の、何がまずいのでしょうか。種のために子どもを控える集団を考えます。", "では、しゅのためのかんがえかたの、なにがまずいのでしょうか。しゅのために、こどもをひかえる、しゅうだんをかんがえます。"),
        ("そこに、遠慮せずたくさん子どもを産む「ズルい個体」が一匹だけ現れたら？", "そこに、えんりょせず、たくさんこどもをうむ、ズルいこたいが、いっぴきだけあらわれたら？"),
        ("ズルい個体の子は、親の性質を受け継いで、またたくさん産みます。世代を重ねるごとに、その割合はどんどん増えていきます。", "ズルいこたいのこは、おやのせいしつをうけついで、またたくさんうみます。せだいをかさねるごとに、そのわりあいは、どんどんふえていきます。"),
        ("つまり「種のために我慢する性質」は、自然選択の中ですぐに消えてしまうのです。", "つまり、しゅのためにがまんするせいしつは、しぜんせんたくのなかで、すぐにきえてしまうのです。"),
    ], s_cheater),
    ("遺伝子の目線", [
        ("そこで登場したのが、1976年のドーキンスの本『利己的な遺伝子』です。", "そこでとうじょうしたのが、せんきゅうひゃくななじゅうろくねんの、ドーキンスのほん、りこてきないでんし、です。"),
        ("この考え方では、体は遺伝子を運ぶための「乗り物」にすぎません。主役は、自分をコピーし続ける遺伝子です。", "このかんがえかたでは、からだは、いでんしをはこぶための、のりものにすぎません。しゅやくは、じぶんをコピーしつづける、いでんしです。"),
        ("何世代もたったあと、生き残っているのは「コピーを残すのがうまかった遺伝子」だけ、というわけです。", "なんせだいもたったあと、いきのこっているのは、コピーをのこすのがうまかったいでんしだけ、というわけです。"),
    ], s_gene),
    ("自然選択のしくみ", [
        ("遺伝子が体をつくり、体が生きのびて子を残し、遺伝子のコピーが増える。このサイクルが何億年も繰り返されてきました。", "いでんしがからだをつくり、からだがいきのびて、こをのこし、いでんしのコピーがふえる。このサイクルが、なんおくねんも、くりかえされてきました。"),
        ("体は一代で死にますが、遺伝子はコピーとして次の世代に受け継がれていきます。", "からだは、いちだいでしにますが、いでんしは、コピーとして、つぎのせだいに、うけつがれていきます。"),
    ], s_cycle),
    ("ライオンの子殺し", [
        ("この考え方を裏付ける例が、ライオンの子殺しです。群れを乗っ取った新しいオスは…", "このかんがえかたを、うらづけるれいが、ライオンのこごろしです。むれをのっとった、あたらしいオスは、"),
        ("前のオスの子どもたちを殺してしまうことがあります。", "まえのオスのこどもたちを、ころしてしまうことがあります。"),
        ("子育て中のメスは妊娠しませんが、子を失うと再び妊娠できるようになり、新しいオスの子を産むのです。", "こそだてちゅうのメスは、にんしんしませんが、こをうしなうと、ふたたびにんしんできるようになり、あたらしいオスのこを、うむのです。"),
        ("種にとってはマイナスでも、オスの遺伝子にとってはプラス。「種のため」では説明できない行動です。", "しゅにとってはマイナスでも、オスのいでんしにとってはプラス。しゅのためでは、せつめいできない、こうどうです。"),
    ], s_lion),
    ("助け合いのナゾ", [
        ("でも、ちょっと待ってください。自然界には、他者を助ける生き物もいますよね。", "でも、ちょっとまってください。しぜんかいには、たしゃをたすける、いきものもいますよね。"),
        ("たとえば働きバチは、一生自分の子を産まず、巣のために働き、敵を刺して死ぬこともあります。", "たとえば、はたらきばちは、いっしょう、じぶんのこをうまず、すのためにはたらき、てきをさしてしぬこともあります。"),
        ("これは「自分の遺伝子を残す」と矛盾しないのでしょうか？", "これは、じぶんのいでんしをのこす、と、むじゅんしないのでしょうか？"),
    ], s_puzzle),
    ("ハミルトン則", [
        ("その答えが、1964年にハミルトンが示した「血縁選択」です。", "そのこたえが、せんきゅうひゃくろくじゅうよねんに、ハミルトンがしめした、けつえんせんたくです。"),
        ("血縁度r、相手が得る利益B、自分が払うコストC。", "けつえんど、アール。あいてがえる、りえき、ビー。じぶんがはらう、コスト、シー。"),
        ("rかけるBがCより大きければ、自分を犠牲にしてでも親族を助ける遺伝子は、集団の中で増えていきます。", "アール かける ビーが、シーよりおおきければ、じぶんをぎせいにしてでも、しんぞくをたすけるいでんしは、しゅうだんのなかで、ふえていきます。"),
    ], s_hamilton),
    ("血縁度とは", [
        ("血縁度とは、ある遺伝子を相手も持っている確率のこと。親子やきょうだいは2分の1、いとこは8分の1です。", "けつえんどとは、あるいでんしを、あいてももっている、かくりつのこと。おやこや、きょうだいは、にぶんのいち。いとこは、はちぶんのいちです。"),
        ("生物学者ホールデンは「兄弟2人か、いとこ8人のためなら命を捨てる」と冗談を言ったとされています。計算上、自分1人分と同じだからです。", "せいぶつがくしゃ、ホールデンは、きょうだいふたりか、いとこはちにんのためなら、いのちをすてる、と、じょうだんをいったとされています。けいさんじょう、じぶんひとりぶんと、おなじだからです。"),
    ], s_family),
    ("ハチの特殊な家族", [
        ("ハチのメスは染色体を2セット、オスは1セットしか持ちません。この特殊な仕組みのせいで…", "ハチのメスは、せんしょくたいを、ふたセット、オスは、ひとセットしかもちません。このとくしゅなしくみのせいで、"),
        ("働きバチどうしの姉妹の血縁度は4分の3。自分で子を産むと2分の1なので、妹を育てるほうが遺伝子的にお得になります。", "はたらきばちどうしの、しまいのけつえんどは、よんぶんのさん。じぶんでこをうむと、にぶんのいちなので、いもうとをそだてるほうが、いでんしてきに、おとくになります。"),
        ("ただし現在では、これだけでなく、巣の環境など他の要因も重要だと考えられています。", "ただし、げんざいでは、これだけでなく、すのかんきょうなど、ほかのよういんも、じゅうようだと、かんがえられています。"),
    ], s_bee),
    ("お互いさまの進化", [
        ("血のつながりがなくても助け合う例があります。チスイコウモリです。", "ちのつながりがなくても、たすけあうれいがあります。チスイコウモリです。"),
        ("彼らは2、3日血を吸えないと餓死してしまうため、たっぷり吸えた個体が、仲間に血を吐き戻して分けてあげます。", "かれらは、にさんにち、ちをすえないと、がししてしまうため、たっぷりすえたこたいが、なかまに、ちをはきもどして、わけてあげます。"),
        ("そして助けてもらった個体は、次はお返しをしやすい。これを「互恵的利他行動」と言います。", "そして、たすけてもらったこたいは、つぎは、おかえしをしやすい。これを、ごけいてきりたこうどう、といいます。"),
        ("長い目で見れば、お互いさまの関係は、自分の遺伝子にとっても得なのです。", "ながいめでみれば、おたがいさまのかんけいは、じぶんのいでんしにとっても、とくなのです。"),
    ], s_bat),
    ("注意ポイント", [
        ("ただし注意。遺伝子に心や意志があるわけではありません。「利己的」はあくまでたとえ話です。", "ただしちゅうい。いでんしに、こころやいしが、あるわけではありません。りこてき、は、あくまでたとえばなしです。"),
        ("また、利己的な遺伝子は、利己的な性格を意味しません。遺伝子が増えるためなら、体はとても協力的にもなります。", "また、りこてきないでんしは、りこてきなせいかくを、いみしません。いでんしがふえるためなら、からだは、とてもきょうりょくてきにもなります。"),
        ("なお、集団レベルでの選択がどこまで働くかは、今も研究と議論が続いているテーマです。", "なお、しゅうだんレベルでのせんたくが、どこまではたらくかは、いまも、けんきゅうとぎろんが、つづいているテーマです。"),
    ], s_caution),
    ("人間の場合", [
        ("では、私たち人間はどうでしょう。私たちの体も、もちろん遺伝子がつくっています。", "では、わたしたちにんげんは、どうでしょう。わたしたちのからだも、もちろん、いでんしがつくっています。"),
        ("でも人間は、養子を育てたり、見知らぬ人に寄付したり、子どもを持たない人生を選んだりもします。", "でもにんげんは、ようしをそだてたり、みしらぬひとに、きふしたり、こどもをもたない、じんせいをえらんだりもします。"),
        ("ドーキンス自身もこう書いています。「この地上で、我々人間だけが、利己的な自己複製子の専制支配に反逆できる」。", "ドーキンスじしんも、こうかいています。このちじょうで、われわれにんげんだけが、りこてきな、じこふくせいしの、せんせいしはいに、はんぎゃくできる。"),
    ], s_human),
    ("まとめ", [
        ("まとめです。生き物は種のためではなく、結果として「自分の遺伝子のコピーを残す」ように生きています。", "まとめです。いきものは、しゅのためではなく、けっかとして、じぶんのいでんしのコピーをのこすように、いきています。"),
        ("助け合いや自己犠牲も、血縁選択やお互いさまで説明できる。でも、遺伝子に縛られないのも人間の面白さ。以上、利己的な遺伝子の雑学でした！", "たすけあいや、じこぎせいも、けつえんせんたくや、おたがいさまで、せつめいできる。でも、いでんしにしばられないのも、にんげんのおもしろさ。いじょう、りこてきないでんしの、ざつがくでした！"),
    ], s_summary),
]

# ---------------------------------------------------------------- audio
GAP = 0.45      # セリフ間
HEAD = 0.6      # シーン冒頭
TAIL = 0.9      # シーン末尾


def tts(s):
    x, sr = pyopenjtalk.tts(s, speed=1.12)
    x = x.astype(np.float32) / 32768.0
    if sr != SR:
        idx = np.arange(0, len(x), sr / SR)
        x = np.interp(idx, np.arange(len(x)), x).astype(np.float32)
    # 先頭末尾の無音を軽く削る
    nz = np.where(np.abs(x) > 0.01)[0]
    if len(nz):
        x = x[max(0, nz[0] - 800): nz[-1] + 2400]
    return x


def build_timeline():
    timeline = []  # (scene_index, start, dur, line_starts(relative), [(text, abs_start, abs_end)])
    voice_chunks = []
    cur = 0.0
    for si, (title, lines, fn) in enumerate(SCENES):
        t = HEAD
        starts, subs = [], []
        for (sub, reading) in lines:
            x = tts(reading or sub)
            d = len(x) / SR
            starts.append(t)
            subs.append((sub, cur + t, cur + t + d))
            voice_chunks.append((cur + t, x))
            t += d + GAP
        T = t - GAP + TAIL
        timeline.append((si, cur, T, starts, subs))
        cur += T
        print(f"scene {si:2d} {title}: {T:5.1f}s", flush=True)
    return timeline, voice_chunks, cur


def bgm(total):
    n = int(total * SR)
    t = np.arange(n) / SR
    out = np.zeros(n, np.float32)
    # Am - F - C - G のやさしいパッド
    chords = [(220.0, 261.63, 329.63), (174.61, 220.0, 261.63), (130.81, 196.0, 261.63), (196.0, 246.94, 293.66)]
    bar = 4.0
    for k in range(int(total / bar) + 1):
        s, e = int(k * bar * SR), min(n, int((k + 1) * bar * SR + 0.5 * SR))
        if s >= n:
            break
        tt = t[s:e] - k * bar
        env = np.minimum(1, tt / 0.8) * np.exp(-tt / 6)
        for f in chords[k % 4]:
            out[s:e] += (np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(4 * np.pi * f * tt)) * env * 0.05
        # 軽いアルペジオ
        for j in range(8):
            f = chords[k % 4][j % 3] * 2
            ps = s + int(j * bar / 8 * SR)
            pe = min(n, ps + int(0.45 * SR))
            if ps >= n:
                break
            u = np.arange(pe - ps) / SR
            out[ps:pe] += np.sin(2 * np.pi * f * u) * np.exp(-u * 7) * 0.035
    fade = np.minimum(1, np.minimum(t / 2, (total - t) / 3))
    return out * fade


def build_audio(voice_chunks, total):
    n = int(total * SR) + SR
    voice = np.zeros(n, np.float32)
    for st, x in voice_chunks:
        i = int(st * SR)
        voice[i:i + len(x)] += x
    voice /= max(1e-6, np.abs(voice).max()) / 0.85
    # ナレーション中はBGMを少し下げる(ダッキング)
    env = np.convolve((np.abs(voice) > 0.02).astype(np.float32), np.ones(SR // 2) / (SR // 2), mode="same")
    music = bgm(n / SR) * (1 - 0.45 * np.clip(env * 3, 0, 1))
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
    """長い字幕は2行ずつのページに分け、文字数比で時間配分する."""
    lines = wrap(s, 34)
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


SUB_PANEL = Image.new("RGBA", (W, 200), (0, 0, 0, 170))


def draw_chrome(img, d, si, gt, subs, t, T):
    title = SCENES[si][0]
    d.rounded_rectangle([30, 24, 60 + len(title) * 36, 76], radius=14, fill=(255, 214, 70))
    d.text((45, 50), title, font=font(34), fill=(20, 24, 40), anchor="lm")
    # 進行バー
    d.rectangle([0, H - 6, int(W * gt / TOTAL), H], fill=YELLOW)
    cur = None
    for (s, a, b) in subs:
        if a - 0.1 <= gt <= b + GAP:
            cur = sub_page(s, a, b, gt)
    if cur:
        h = 60 * len(cur) + 28
        top = H - h - 14
        img.paste(SUB_PANEL.crop((0, 0, W, h)), (0, top), SUB_PANEL.crop((0, 0, W, h)))
        for i, ln in enumerate(cur):
            d.text((W / 2, top + 44 + i * 60), ln, font=font(48), fill=WHITE, anchor="mm",
                   stroke_width=3, stroke_fill=(0, 0, 0))


def render(timeline, audio_path, total):
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
           "-r", str(FPS), "-i", "-", "-i", audio_path, "-c:v", "libx264", "-preset", "medium", "-crf", "20",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", OUT]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    nframes = int(total * FPS)
    si = 0
    for f in range(nframes):
        gt = f / FPS
        while si < len(timeline) - 1 and gt >= timeline[si][1] + timeline[si][2]:
            si += 1
        _, st, T, L, subs = timeline[si]
        t = gt - st
        img = BG.copy()
        d = ImageDraw.Draw(img)
        SCENES[si][2](d, t, T, L)
        # シーン切替のフェード
        fade = min(1.0, t / 0.35, (T - t) / 0.3 if si < len(timeline) - 1 else 1.0)
        if fade < 1.0:
            img = Image.blend(Image.new("RGB", (W, H), (5, 8, 18)), img, max(0.0, fade))
            d = ImageDraw.Draw(img)
        draw_chrome(img, d, si, gt, subs, t, T)
        p.stdin.write(img.tobytes())
        if f % 300 == 0:
            print(f"frame {f}/{nframes}", flush=True)
    p.stdin.close()
    p.wait()


if __name__ == "__main__":
    tl, vc, TOTAL = build_timeline()
    print(f"total {TOTAL:.1f}s", flush=True)
    ap = build_audio(vc, TOTAL)
    if "--preview" in sys.argv:
        # 各シーン中盤のスナップショットだけ書き出す
        for si, st, T, L, subs in tl:
            for frac in (0.95,):
                t = T * frac
                img = BG.copy()
                d = ImageDraw.Draw(img)
                SCENES[si][2](d, t, T, L)
                draw_chrome(img, d, si, st + t, subs, t, T)
                img.save(os.path.join(TMP, f"preview_{si:02d}.png"))
        sys.exit(0)
    render(tl, ap, TOTAL)
    print("done:", OUT)
