# -*- coding: utf-8 -*-
"""YouTubeショート版 (縦1080x1920, 60秒以内) を作る: python3 make_short.py [--preview] -> selfish_gene_short.mp4

本編 (make_video.py) の素材・描画関数・音声合成を再利用する。
"""
import math
import os
import subprocess
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

import make_video as mv  # noqa: E402

# 縦長に切り替え (make_video の関数は mv.W / mv.H を参照する)
W, H = 1080, 1920
mv.W, mv.H = W, H
BG = mv.make_bg()
OUT = os.path.join(mv.HERE, "selfish_gene_short.mp4")
FPS, SR = mv.FPS, mv.SR
Z, M = mv.ZUN, mv.MET
text3d, label, card, appear, pop = mv.text3d, mv.label, mv.card, mv.appear, mv.pop
YELLOW, WHITE, RED, GREEN, PINK, PURPLE, GRAY = mv.YELLOW, mv.WHITE, mv.RED, mv.GREEN, mv.PINK, mv.PURPLE, mv.GRAY


def Lk(L, k, T):
    return L[k] if k < len(L) else T + 99


# ---------------------------------------------------------------- scenes (縦型)
def s_hook(img, d, t, T, L):
    mv.photo_bg(img, "lion_bg", t, T, dim=0.45, zoom=(1.0, 1.15), focus=(0.5, 0.4))
    mv.seq3d(img, "dna", 960, 1060, 300, t, appear(t, 0.3), scale=pop(t, 0.3))
    text3d(d, (W / 2, 360), "生き物は", 120, WHITE, appear(t, 0.1))
    text3d(d, (W / 2, 580), "種のため", 210, YELLOW, appear(t, 0.2), depth=12)
    text3d(d, (W / 2, 800), "に生きてる？", 120, WHITE, appear(t, 0.3))
    k = Lk(L, 1, T)
    if t >= k:
        a = pop(t, k)
        for off, col in ((8, (90, 0, 0)), (0, (255, 50, 60))):
            d.line([(110 + off, 480 + off), (970 + off, 680 + off)], fill=mv.rgba(col, min(1, a)), width=int(34 * max(0.05, a)))
        text3d(d, (W / 2, 1010), "実は まちがい！", 96, RED, appear(t, k + 0.2))


def s_lion(img, d, t, T, L):
    mv.photo_bg(img, "lion_family", t, T, dim=0.6, zoom=(1.0, 1.12))
    text3d(d, (W / 2, 230), "新しいボスライオンは…", 80, WHITE, appear(t, 0.1))
    mv.polaroid(img, "lion_male", 330, 560, 380, 420, rot=-4, scale=pop(t, 0.2), focus=(0.5, 0.3), caption="新しいオス")
    mv.arrow3d(d, (560, 560), (640, 760), RED, appear(t, 0.8))
    mv.polaroid(img, "cubs", 740, 900, 460, 300, rot=4, scale=pop(t, 0.9), caption="前のオスの子")
    mv.stamp_x(d, 740, 880, 120, pop(t, 1.6))
    k = Lk(L, 1, T)
    if t >= k:
        text3d(d, (W / 2, 1180), "種のためなら ありえない！", 72, YELLOW, appear(t, k))


def s_cheat(img, d, t, T, L):
    mv.photo_bg(img, "mouse", t, T, dim=0.72, zoom=(1.0, 1.08), blur=True)
    text3d(d, (W / 2, 230), "「ズルい個体」が", 84, WHITE, appear(t, 0.1))
    text3d(d, (W / 2, 340), "1割まざったら？", 84, PURPLE, appear(t, 0.1))
    m = mv.seq_meta("bars")
    tb = mv.clamp((t - 0.6) / max(1.5, (T - 1.5) * 0.7)) * m["seconds"]
    r = mv.seq3d(img, "bars", W / 2, 760, 520, tb, appear(t, 0.4))
    if r:
        f, left, top, i = r
        p = 0.1
        for g, (x, y, e, bx, by) in enumerate(m["data"][i]):
            hl = g in (3, 7)
            if e > 0.25:
                label(d, (left + x * f, top + y * f - 8), f"{p * 100:.0f}%", 34 if hl else 26, RED if hl else WHITE, mv.clamp(e))
            label(d, (left + bx * f, top + by * f + 20), f"{g}", 24, GRAY, appear(t, 0.4))
            p = 2 * p / (2 * p + (1 - p))
    label(d, (W / 2, 1060), "世代 →", 36, WHITE, appear(t, 0.4))
    k = Lk(L, 1, T)
    if t >= k:
        card(img, (120, 1110, 960, 1210), appear(t, k), (170, 30, 50), YELLOW)
        label(d, (W / 2, 1160), "ズルい方が あっという間に勝つ！", 46, YELLOW, appear(t, k))


def s_gene(img, d, t, T, L):
    mv.photo_bg(img, "dna", t, T, dim=0.5, zoom=(1.0, 1.18))
    text3d(d, (W / 2, 230), "残るのは", 90, WHITE, appear(t, 0.1))
    text3d(d, (W / 2, 350), "コピー上手な遺伝子", 90, YELLOW, appear(t, 0.2))
    mv.seq3d(img, "dna", 270, 760, 560, t, appear(t, 0.3), scale=pop(t, 0.3))
    mv.arrow3d(d, (420, 760), (520, 760), PINK, appear(t, 0.8))
    mv.polaroid(img, "lion_rock", 760, 740, 420, 280, rot=3, scale=pop(t, 0.9), caption="体＝遺伝子の乗り物")
    k = Lk(L, 0, T) + 3.0
    mv.polaroid(img, "cubs", 760, 1060, 360, 230, rot=-4, scale=pop(t, k), caption="次の体へ")


def s_bee(img, d, t, T, L):
    mv.photo_bg(img, "bees", t, T, dim=0.55, zoom=(1.0, 1.25), focus=(0.55, 0.4))
    text3d(d, (W / 2, 230), "働きバチが", 90, WHITE, appear(t, 0.1))
    text3d(d, (W / 2, 345), "妹を育てるのは？", 90, YELLOW, appear(t, 0.1))
    mv.seq3d(img, "honeycomb", W / 2, 640, 380, t, appear(t, 0.2), scale=pop(t, 0.2))
    k = Lk(L, 1, T)
    if t >= k:
        b = appear(t, k)
        x0, y0 = 90, 880
        label(d, (x0, y0 + 28), "姉妹との血縁度", 40, WHITE, b, anchor="lm")
        mv.hbar3d(d, x0, y0 + 60, 820 * 0.75 * b, 64, GREEN, b)
        text3d(d, (x0 + 30 + 820 * 0.75 * b, y0 + 92), "3/4", 60, GREEN, b, anchor="lm")
        c = appear(t, k + 1.0)
        label(d, (x0, y0 + 178), "自分の子との血縁度", 40, WHITE, c, anchor="lm")
        mv.hbar3d(d, x0, y0 + 210, 820 * 0.5 * c, 64, PINK, c)
        text3d(d, (x0 + 30 + 820 * 0.5 * c, y0 + 242), "1/2", 60, PINK, c, anchor="lm")
        label(d, (W / 2, 1210), "※ 一つの説。他の要因も重要とされています", 30, GRAY, b)


def s_end(img, d, t, T, L):
    mv.photo_bg(img, "lion_rock", t, T, dim=0.65, zoom=(1.0, 1.1), blur=True)
    text3d(d, (W / 2, 360), "生き物は", 110, WHITE, appear(t, 0.1))
    text3d(d, (W / 2, 540), "自分の遺伝子", 140, YELLOW, appear(t, 0.2), depth=10)
    text3d(d, (W / 2, 720), "のために生きている", 96, WHITE, appear(t, 0.3))
    mv.seq3d(img, "dna", W / 2, 960, 300, t, appear(t, 0.4))
    k = Lk(L, 1, T)
    if t >= k:
        card(img, (160, 1120, 920, 1220), appear(t, k), (60, 140, 70), WHITE)
        label(d, (W / 2, 1170), "くわしくは本編で！", 54, WHITE, appear(t, k))


SCENES = [
    ("hook", [(Z, "動物って、種を守るために生きてるのだ？", None),
              (M, "実はそれ、まちがいですわ！", None)], s_hook),
    ("lion", [(M, "新しいボスのオスライオンは、前のオスの子どもを殺してしまうことがありますの。", None),
              (Z, "種のためなら、ありえないのだ！", None)], s_lion),
    ("cheat", [(M, "我慢する群れに、ズルく多く産む個体が1割まざると、7世代で9割を超えますの。", None),
               (Z, "ズルい方が勝っちゃうのだ…！", None)], s_cheat),
    ("gene", [(M, "だから残るのは、自分のコピーを増やすのがうまい遺伝子。体は、遺伝子の乗り物なんですわ。", None)], s_gene),
    ("bee", [(Z, "じゃあ、働きバチが妹を育てるのは？", None),
             (M, "一つの説では、姉妹は遺伝子を4分の3も共有するから、遺伝子的にはお得なんですの。", None)], s_bee),
    ("end", [(Z, "生き物は、自分の遺伝子のために生きてたのだ！", None),
             (M, "くわしくは本編でどうぞ。", None)], s_end),
]

GAP, HEAD, TAIL = 0.2, 0.25, 0.45


def build_timeline():
    tl, chunks, cur = [], [], 0.0
    for si, (name, lines, fn) in enumerate(SCENES):
        t = HEAD
        starts, subs = [], []
        for spk, sub, reading in lines:
            x = mv.tts(reading or sub, spk)
            dur = len(x) / SR
            starts.append(t)
            subs.append((sub, cur + t, cur + t + dur, spk))
            chunks.append((cur + t, x))
            t += dur + GAP
        T = t - GAP + TAIL
        tl.append((si, cur, T, starts, subs))
        cur += T
        print(f"short {name}: {T:4.1f}s", flush=True)
    return tl, chunks, cur


def build_audio(chunks, total):
    n = int(total * SR) + SR // 2
    voice = np.zeros(n, np.float32)
    for st, x in chunks:
        i = int(st * SR)
        voice[i:i + len(x)] += x[:n - i]
    voice /= max(1e-6, np.abs(voice).max()) / 0.9
    env = np.convolve((np.abs(voice) > 0.02).astype(np.float32), np.ones(SR // 2) / (SR // 2), mode="same")
    music = mv.bgm(n / SR) * (1 - 0.5 * np.clip(env * 3, 0, 1)) * 0.8
    mixed = np.clip(voice + music, -1, 1)
    path = os.path.join(mv.TMP, "audio_short.wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((mixed * 32767).astype(np.int16).tobytes())
    return path


def draw_chrome(img, d, gt, subs):
    # クレジット (上部, ショートのUIと重ならない位置)
    label(d, (W / 2, 120), mv.CREDIT_VOICE, 24, (230, 240, 230), 0.85)
    cur, spk = None, None
    for (s, a, b, sp) in subs:
        if a - 0.1 <= gt <= b + GAP:
            lines = mv.wrap(s, 14)
            pages = [lines[i:i + 3] for i in range(0, len(lines), 3)]
            if len(pages) == 1:
                cur = pages[0]
            else:
                tot = sum(len("".join(p)) for p in pages)
                acc = a
                cur = pages[-1]
                for p in pages:
                    acc += (b - a) * len("".join(p)) / tot
                    if gt < acc:
                        cur = p
                        break
            spk = sp
    if cur:
        info = mv.SPEAKERS[spk]
        top = 1290
        nw = len(info["name"]) * 36 + 44
        d.rounded_rectangle([70, top - 64, 70 + nw, top - 10], radius=16, fill=info["color"] + (255,), outline=(255, 255, 255, 255), width=3)
        d.text((70 + nw / 2, top - 37), info["name"], font=mv.font(36), fill=WHITE, anchor="mm")
        for i, ln in enumerate(cur):
            y = top + 45 + i * 80
            d.text((W / 2, y), ln, font=mv.font(64), fill=WHITE, anchor="mm", stroke_width=11, stroke_fill=info["color"])
            d.text((W / 2, y), ln, font=mv.font(64), fill=WHITE, anchor="mm", stroke_width=5, stroke_fill=info["dark"])


def frame(tl, si, gt):
    _, st, T, L, subs = tl[si]
    t = gt - st
    img = BG.copy()
    d = ImageDraw.Draw(img, "RGBA")
    SCENES[si][2](img, d, t, T, L)
    fade = min(1.0, t / 0.2, (T - t) / 0.15 if si < len(tl) - 1 else 1.0)
    if fade < 1.0:
        img = Image.blend(Image.new("RGB", (W, H), (5, 6, 20)), img, max(0.0, fade))
        d = ImageDraw.Draw(img, "RGBA")
    draw_chrome(img, d, gt, subs)
    return img


def main():
    tl, chunks, total = build_timeline()
    print(f"short total {total:.1f}s", flush=True)
    ap = build_audio(chunks, total)
    if "--preview" in sys.argv:
        for si, st, T, L, subs in tl:
            frame(tl, si, st + T * 0.9).save(os.path.join(mv.TMP, f"short_{si:02d}.png"))
        return
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
           "-r", str(FPS), "-i", "-", "-i", ap, "-c:v", "libx264", "-preset", "slow", "-crf", "23",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", OUT]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    si = 0
    n = int(total * FPS)
    for f in range(n):
        gt = f / FPS
        while si < len(tl) - 1 and gt >= tl[si][1] + tl[si][2]:
            si += 1
        p.stdin.write(frame(tl, si, gt).tobytes())
        if f % 300 == 0:
            print(f"frame {f}/{n}", flush=True)
    p.stdin.close()
    p.wait()
    print("done:", OUT)


if __name__ == "__main__":
    main()
