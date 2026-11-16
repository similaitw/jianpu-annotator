#!/usr/bin/env bash
# 部署到 Google Cloud Run（有免費額度，會自動縮到 0）。需要先：
#   1. 有 Google Cloud 專案並啟用帳單（會要信用卡，用量在免費額度內不收費）
#   2. 安裝 gcloud 並 gcloud auth login、gcloud config set project 你的專案ID
# 用法： ./deploy-cloudrun.sh https://你的網站網址
set -euo pipefail
cd "$(dirname "$0")"
ORIGIN="${1:?請帶入你的網站網址，例如 https://xxx.vercel.app}"
REGION="${REGION:-us-central1}"   # 一級區域，免費額度最多；台灣 asia-east1 較近但免費額度較少
KEY="${API_KEY:-$(openssl rand -hex 24)}"

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
gcloud run deploy jianpu-omr \
  --source . \
  --region "$REGION" \
  --memory 4Gi --cpu 2 \
  --concurrency 1 \
  --min-instances 0 --max-instances 2 \
  --timeout 900 \
  --allow-unauthenticated \
  --set-env-vars "JIANPU_OMR_API_KEY=$KEY,JIANPU_OMR_ORIGINS=$ORIGIN,JIANPU_OMR_CONCURRENCY=1"

URL=$(gcloud run services describe jianpu-omr --region "$REGION" --format 'value(status.url)')
echo
echo "================ 完成 ================"
echo "服務位址： $URL"
echo "API 金鑰： $KEY    （請記下來）"
echo "到網頁「圖檔辨識設定」填入以上兩項。第一次呼叫會冷啟動，約多等 10–30 秒。"
