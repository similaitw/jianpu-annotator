#!/usr/bin/env python3
"""簡譜標註器 — 本機圖檔辨識服務。

網頁把樂譜圖檔（PNG／JPG／PDF）傳到這裡，這裡用 homr（開源 OMR）辨識成 MusicXML 後回傳。
只綁定 127.0.0.1，圖檔不會離開你的電腦。

啟動：  python server.py        （預設 http://127.0.0.1:8765）
"""
import os, shutil, subprocess, sys, tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

HOST = os.environ.get("JIANPU_OMR_HOST", "127.0.0.1")
PORT = int(os.environ.get("JIANPU_OMR_PORT", "8765"))
TIMEOUT = int(os.environ.get("JIANPU_OMR_TIMEOUT", "900"))
MAX_BYTES = 40 * 1024 * 1024

app = FastAPI(title="jianpu-annotator OMR")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def private_network(request: Request, call_next):
    # Chrome 從 https 網頁呼叫 localhost 時需要這個標頭
    resp = await call_next(request)
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    return resp


def homr_cmd(image: Path):
    exe = shutil.which("homr")
    if exe:
        return [exe, str(image)]
    return [sys.executable, "-m", "homr.main", str(image)]


def prepare_image(src: Path, dst: Path, page: int):
    """PDF 取指定頁；圖片太小就放大（小圖辨識率差）。輸出 PNG。"""
    if src.suffix.lower() == ".pdf":
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(str(src))
        if page < 1 or page > len(pdf):
            raise HTTPException(400, f"PDF 只有 {len(pdf)} 頁，沒有第 {page} 頁")
        img = pdf[page - 1].render(scale=3).to_pil().convert("RGB")
    else:
        img = Image.open(src)
        img = img.convert("RGB")
    long_edge = max(img.size)
    if long_edge < 3000:
        f = 3000 / long_edge
        img = img.resize((round(img.width * f), round(img.height * f)), Image.LANCZOS)
    img.save(dst, "PNG")


@app.get("/health")
def health():
    ok = bool(shutil.which("homr")) or _can_import("homr")
    return {"ok": True, "homr": ok}


def _can_import(name):
    import importlib.util
    return importlib.util.find_spec(name) is not None


@app.post("/recognize")
async def recognize(file: UploadFile = File(...), page: int = Form(1)):
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "檔案太大（上限 40 MB）")
    suffix = Path(file.filename or "score.png").suffix.lower() or ".png"
    if suffix not in {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff", ".pdf"}:
        raise HTTPException(400, "只支援 PNG、JPG、BMP、WebP、TIFF 或 PDF")
    with tempfile.TemporaryDirectory(prefix="jianpu_omr_") as td:
        td = Path(td)
        src = td / f"input{suffix}"
        src.write_bytes(data)
        png = td / "score.png"
        try:
            prepare_image(src, png, page)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(400, f"無法讀取圖檔：{e}")
        try:
            proc = subprocess.run(homr_cmd(png), cwd=td, capture_output=True, text=True, timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            raise HTTPException(504, f"辨識超過 {TIMEOUT} 秒，已中止")
        except FileNotFoundError:
            raise HTTPException(500, "找不到 homr，請先執行 pip install -r requirements.txt")
        out = td / "score.musicxml"
        if proc.returncode != 0 or not out.exists():
            tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-6:]
            raise HTTPException(422, "辨識失敗：" + " / ".join(tail))
        xml = out.read_text(encoding="utf-8")
    return {"musicxml": xml, "engine": "homr"}


if __name__ == "__main__":
    import uvicorn
    print(f"圖檔辨識服務啟動：http://127.0.0.1:{PORT}（第一次辨識會下載模型，需要連網）", flush=True)
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
