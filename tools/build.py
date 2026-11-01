# -*- coding: utf-8 -*-
"""src/ の HTML・CSS・JS（core.js / rts_sim.js / app.js）と data/mapdata.json を 1 つの index.html に組み立てる。

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
    # core（土台・描画）→ rts_sim（ルール・AI）→ app（画面・入力）の順に1つのスコープへまとめる
    parts = [read("src", f) for f in ("core.js", "sprites.js", "rts_sim.js", "net.js", "app.js")]
    js = "'use strict';\n(() => {\n" + "\n".join(parts) + "\n})();\n"
    data = json.loads(read("data", "mapdata.json"))
    # </script> がデータ中に現れないことを保証
    data_txt = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    html = html.replace("/*__STYLE__*/", css)
    html = html.replace("/*__MAPDATA__*/", data_txt)
    # index.html：1人用（端末の中でAIと対戦）／ online.html：オンライン版（server/server.js が配る。地図は3倍細かい）
    # trial.html：お試し版（中国・四国の9県だけ、オンライン版と同じ1マス≒90m。参加者はAIで5倍）
    trial = "window.JINCHI_TRIAL = { S: 3, prefs: [31, 32, 33, 34, 35, 36, 37, 38, 39], mul: 5, fast: true };\n"
    for name, pre in (("index.html", ""), ("online.html", "window.JINCHI_ONLINE = { S: 3 };\n"), ("trial.html", trial)):
        out = os.path.join(ROOT, name)
        with open(out, "w", encoding="utf-8") as f:
            f.write(html.replace("/*__GAME__*/", pre + js))
        print(f"wrote {out} ({os.path.getsize(out) // 1024} KB)")


if __name__ == "__main__":
    main()
