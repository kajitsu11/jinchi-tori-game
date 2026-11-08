# -*- coding: utf-8 -*-
"""YouTube用サムネイル (1280x720) を作る: python3 make_thumbnail.py -> thumbnail.png"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_video as mv  # noqa: E402
from PIL import Image, ImageDraw, ImageFilter  # noqa: E402

W, H = mv.W, mv.H  # 1920x1080 で描いて最後に縮小


def bubble(d, box, tail, fill, text, size, color=mv.WHITE, stroke=None):
    x0, y0, x1, y1 = box
    d.polygon([tail[0], tail[1], tail[2]], fill=fill + (255,), outline=(255, 255, 255, 255))
    d.rounded_rectangle(box, radius=40, fill=fill + (255,), outline=(255, 255, 255, 255), width=8)
    d.polygon([tail[0], tail[1], tail[2]], fill=fill + (255,))
    d.text(((x0 + x1) / 2, (y0 + y1) / 2), text, font=mv.font(size), fill=color, anchor="mm",
           stroke_width=stroke or 0, stroke_fill=(0, 0, 0))


def big(d, xy, s, size, fill, outline, ow=14, shadow=10, anchor="lm"):
    x, y = xy
    f = mv.font(size)
    d.text((x + shadow, y + shadow), s, font=f, fill=(0, 0, 0, 200), anchor=anchor, stroke_width=ow, stroke_fill=(0, 0, 0, 200))
    d.text((x, y), s, font=f, fill=fill, anchor=anchor, stroke_width=ow, stroke_fill=outline)
    # 擬似太字 (IPAゴシックは細いので少しずらして重ね描き)
    d.text((x + 2, y), s, font=f, fill=fill, anchor=anchor)


def main():
    img = Image.new("RGB", (W, H), (10, 12, 30))
    # 右側: オスライオンの写真
    lion = mv._cover_img("lion_male", 1400, H, (0.5, 0.3))
    img.paste(lion, (W - 1400, 0))
    # 左から右へ暗くなるグラデーション
    grad = Image.new("L", (W, 1))
    for x in range(W):
        u = min(1.0, max(0.0, (x - 600) / 800))
        v = int(255 * (1 - u * u * (3 - 2 * u)))
        grad.putpixel((x, 0), v)
    dark = Image.new("RGB", (W, H), (12, 14, 40))
    img.paste(dark, (0, 0), grad.resize((W, H)))
    # 集中線っぽい光
    rays = Image.new("RGBA", (W, H), (0, 0, 0, 0))  # 左側だけに重ねる
    rd = ImageDraw.Draw(rays)
    import math
    for k in range(36):
        a = k / 36 * 2 * math.pi
        rd.polygon([(520, 540), (520 + 2400 * math.cos(a), 540 + 2400 * math.sin(a)),
                    (520 + 2400 * math.cos(a + 0.05), 540 + 2400 * math.sin(a + 0.05))], fill=(255, 220, 80, 28))
    rays.putalpha(Image.composite(rays.getchannel('A'), Image.new('L', (W, H), 0), grad.resize((W, H))))
    img.paste(rays, (0, 0), rays)

    # 3D DNA (右下)
    mv.seq3d(img, "dna", 1790, 700, 700, 1.2)

    d = ImageDraw.Draw(img, "RGBA")
    # 左上タグ
    d.rounded_rectangle([50, 40, 520, 140], radius=24, fill=(60, 170, 70, 255), outline=(255, 255, 255, 255), width=6)
    d.text((285, 90), "ずんだもん解説", font=mv.font(62), fill=mv.WHITE, anchor="mm", stroke_width=3, stroke_fill=(20, 70, 25))

    # メインコピー
    big(d, (60, 270), "生き物は", 150, (255, 255, 255), (20, 20, 40))
    big(d, (50, 520), "種のため", 250, (255, 214, 40), (150, 20, 20), ow=18)
    # 「種のため」に赤い×
    for off, col in ((10, (90, 0, 0, 255)), (0, (255, 50, 60, 255))):
        d.line([(80 + off, 400 + off), (1040 + off, 650 + off)], fill=col, width=36)
    big(d, (60, 790), "に生きてない！？", 140, (255, 255, 255), (20, 20, 40))

    # 下帯
    d.rounded_rectangle([40, 900, 1120, 1040], radius=30, fill=(200, 30, 50, 255), outline=(255, 255, 255, 255), width=6)
    d.text((580, 970), "答えは「利己的な遺伝子」", font=mv.font(84), fill=(255, 240, 120), anchor="mm",
           stroke_width=6, stroke_fill=(90, 0, 10))

    # 吹き出し (右上)
    bubble(d, (1130, 60, 1880, 230), [(1420, 225), (1500, 225), (1440, 330)], (60, 170, 70), "体は遺伝子の乗り物…！？", 58, stroke=4)

    img = img.resize((1280, 720), Image.LANCZOS)
    out = os.path.join(mv.HERE, "thumbnail.png")
    img.save(out, optimize=True)
    print(out, os.path.getsize(out))


if __name__ == "__main__":
    main()
