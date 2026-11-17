#!/usr/bin/env python3
"""簡譜標註器 — 本機圖檔辨識服務。

網頁把樂譜圖檔（PNG／JPG／PDF）傳到這裡，這裡用 homr（開源 OMR）辨識成 MusicXML 後回傳。
只綁定 127.0.0.1，圖檔不會離開你的電腦。

啟動：  python server.py        （預設 http://127.0.0.1:8765）
"""
import asyncio, hmac, os, shutil, subprocess, sys, tempfile, time, uuid
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

HOST = os.environ.get("JIANPU_OMR_HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT") or os.environ.get("JIANPU_OMR_PORT", "8765"))  # Cloud Run 會給 PORT
TIMEOUT = int(os.environ.get("JIANPU_OMR_TIMEOUT", "900"))
MAX_BYTES = 40 * 1024 * 1024
API_KEY = os.environ.get("JIANPU_OMR_API_KEY", "").strip()          # 遠端部署時務必設定
ORIGINS = [o.strip() for o in os.environ.get("JIANPU_OMR_ORIGINS", "*").split(",") if o.strip()]
CONCURRENCY = max(1, int(os.environ.get("JIANPU_OMR_CONCURRENCY", "1")))  # 同時辨識幾張（吃 CPU／記憶體）
MAX_WAITING = int(os.environ.get("JIANPU_OMR_MAX_WAITING", "4"))          # 排隊上限，超過回 429
JOBS = os.environ.get("JIANPU_OMR_JOBS", "") == "1"                 # 啟用 /jobs（通道有回應時間上限時用）
JOB_TTL = 1800
_sem = asyncio.Semaphore(CONCURRENCY)
_waiting = 0

app = FastAPI(title="jianpu-annotator OMR")
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["*"], allow_headers=["*"])


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


def require_key(x_api_key: str = Header(default="")):
    if API_KEY and not hmac.compare_digest(x_api_key.encode(), API_KEY.encode()):
        raise HTTPException(401, "需要正確的 API 金鑰")


@app.get("/health")
def health():
    ok = bool(shutil.which("homr")) or _can_import("homr")
    return {"ok": True, "homr": ok, "auth": bool(API_KEY), "jobs": JOBS}


@app.get("/check", dependencies=[Depends(require_key)])
def check():
    return {"ok": True}


def _can_import(name):
    import importlib.util
    return importlib.util.find_spec(name) is not None


ALLOWED_SUFFIX = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff", ".pdf"}


async def _run_omr(data: bytes, filename: str, page: int) -> str:
    """實際辨識（含排隊）。成功回 MusicXML 字串，失敗丟 HTTPException。"""
    global _waiting
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "檔案太大（上限 40 MB）")
    suffix = Path(filename or "score.png").suffix.lower() or ".png"
    if suffix not in ALLOWED_SUFFIX:
        raise HTTPException(400, "只支援 PNG、JPG、BMP、WebP、TIFF 或 PDF")
    with tempfile.TemporaryDirectory(prefix="jianpu_omr_") as td:
        td = Path(td)
        src = td / f"input{suffix}"
        src.write_bytes(data)
        png = td / "score.png"
        _waiting += 1
        try:
            async with _sem:
                try:
                    await asyncio.to_thread(prepare_image, src, png, page)
                except HTTPException:
                    raise
                except Exception as e:
                    raise HTTPException(400, f"無法讀取圖檔：{e}")
                try:
                    proc = await asyncio.to_thread(
                        subprocess.run, homr_cmd(png), cwd=td, capture_output=True, text=True, timeout=TIMEOUT)
                except subprocess.TimeoutExpired:
                    raise HTTPException(504, f"辨識超過 {TIMEOUT} 秒，已中止")
                except FileNotFoundError:
                    raise HTTPException(500, "找不到 homr，請先執行 pip install -r requirements.txt")
        finally:
            _waiting -= 1
        out = td / "score.musicxml"
        if proc.returncode != 0 or not out.exists():
            tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-6:]
            raise HTTPException(422, "辨識失敗：" + " / ".join(tail))
        return out.read_text(encoding="utf-8")


@app.post("/recognize")
async def recognize(file: UploadFile = File(...), page: int = Form(1), _auth=Depends(require_key)):
    """同步辨識：連線會一直開著直到辨識完成（本機、Cloud Run 適用）。"""
    if _waiting >= MAX_WAITING:
        raise HTTPException(429, "目前辨識的人太多，請稍後再試")
    xml = await _run_omr(await file.read(), file.filename, page)
    return {"musicxml": xml, "engine": "homr"}


# ---- 非同步工作（Cloudflare Tunnel 等有 100 秒回應上限的通道用）----
_jobs: dict = {}


def _gc_jobs():
    now = time.time()
    for k in [k for k, v in _jobs.items() if now - v["t"] > JOB_TTL]:
        _jobs.pop(k, None)


async def _job_worker(jid: str, data: bytes, filename: str, page: int):
    job = _jobs[jid]
    job["status"] = "running"
    try:
        job["musicxml"] = await _run_omr(data, filename, page)
        job["status"] = "done"
    except HTTPException as e:
        job["status"], job["detail"] = "error", str(e.detail)
    except Exception as e:  # noqa
        job["status"], job["detail"] = "error", f"內部錯誤：{e}"
    job["t"] = time.time()


@app.post("/jobs")
async def create_job(file: UploadFile = File(...), page: int = Form(1), _auth=Depends(require_key)):
    if not JOBS:
        raise HTTPException(404, "此服務未啟用非同步工作（JIANPU_OMR_JOBS=1）")
    _gc_jobs()
    if _waiting >= MAX_WAITING:
        raise HTTPException(429, "目前辨識的人太多，請稍後再試")
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "檔案太大（上限 40 MB）")
    jid = uuid.uuid4().hex
    _jobs[jid] = {"status": "queued", "t": time.time()}
    asyncio.create_task(_job_worker(jid, data, file.filename, page))
    return {"id": jid}


@app.get("/jobs/{jid}", dependencies=[Depends(require_key)])
def job_status(jid: str):
    job = _jobs.get(jid)
    if not job:
        raise HTTPException(404, "找不到這個工作（可能已過期）")
    out = {"status": job["status"]}
    if job["status"] == "done":
        out["musicxml"] = job["musicxml"]
    if job["status"] == "error":
        out["detail"] = job.get("detail", "")
    return out


if __name__ == "__main__":
    import uvicorn
    if HOST not in ("127.0.0.1", "localhost") and not API_KEY:
        print("警告：服務對外開放但沒有設定 JIANPU_OMR_API_KEY，任何人都能使用！", flush=True)
    print(f"圖檔辨識服務啟動：http://127.0.0.1:{PORT}（第一次辨識會下載模型，需要連網）", flush=True)
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
