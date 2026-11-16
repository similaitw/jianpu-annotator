#!/usr/bin/env python3
"""把 src/ 與 vendor/ 組成單一 index.html（Vercel 靜態部署，不需其他建置）。"""
import json, pathlib
root = pathlib.Path(__file__).parent
rd = lambda p: (root / p).read_text(encoding="utf-8")
vf = rd("vendor/vexflow-bravura.js").replace("</script", "<\\/script")
sample = "window.SAMPLE_XML=" + json.dumps(rd("src/sample.musicxml"), ensure_ascii=False).replace("</", "<\\/") + ";"
html = rd("src/template.html").replace("%%VEXFLOW%%", vf).replace("%%SAMPLE%%", sample).replace("%%APP%%", rd("src/app.js"))
(root / "index.html").write_text(html, encoding="utf-8")
print("index.html", len(html), "bytes")
