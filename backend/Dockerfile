FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    JIANPU_OMR_HOST=0.0.0.0 JIANPU_OMR_PORT=8765
WORKDIR /app

# opencv 需要的系統函式庫
RUN apt-get update \
 && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

# 建置時就下載辨識模型，之後執行不需要連網
RUN homr --init

COPY server.py .

EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/health').status==200 else 1)"
CMD ["python", "server.py"]
