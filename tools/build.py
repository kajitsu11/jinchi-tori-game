# -*- coding: utf-8 -*-
"""src/ の HTML・CSS・JS と data/mapdata.json を 1 つの index.html に組み立てる。

使い方: python3 tools/build.py   →  index.html
"""
import json
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


def main():
    html = read("src", "template.html")
    css = read("src", "style.css")
    js = read("src", "game.js")
    data = json.loads(read("data", "mapdata.json"))
    # </script> がデータ中に現れないことを保証
    data_txt = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    html = html.replace("/*__STYLE__*/", css)
    html = html.replace("/*__MAPDATA__*/", data_txt)
    html = html.replace("/*__GAME__*/", js)
    out = os.path.join(ROOT, "index.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"wrote {out} ({os.path.getsize(out) // 1024} KB)")


if __name__ == "__main__":
    main()
