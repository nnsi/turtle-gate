#!/bin/bash
# 日次バスケットペーパートレード パイプライン
# Windowsタスクスケジューラから毎営業日06:00 JSTに実行
#
# Usage:
#   bash scripts/daily-basket-paper.sh
#
# 環境変数:
#   BROKER_PROVIDER=mock (デフォルト、ペーパートレード)
#   LLM_PROVIDER=mock   (デフォルト、LLMは Phase E まで不要)

set -euo pipefail
cd "$(dirname "$0")/.."

# 週末(土日)はスキップ — JPX休場日
DOW=$(date +%u)  # 1=Mon ... 7=Sun
if [ "$DOW" -ge 6 ]; then
  echo "Weekend (day=$DOW) — skipping pipeline."
  exit 0
fi

export BROKER_PROVIDER="${BROKER_PROVIDER:-mock}"
export LLM_PROVIDER="${LLM_PROVIDER:-mock}"

DATE=$(date +%Y-%m-%d)
LOG="output/daily-log-${DATE}.txt"
mkdir -p output

echo "=== Daily Basket Paper Trade: ${DATE} ===" | tee "$LOG"
echo "Broker: ${BROKER_PROVIDER}, LLM: ${LLM_PROVIDER}" | tee -a "$LOG"
echo "" | tee -a "$LOG"

# 1. シグナル生成 (06:00)
echo "[$(date +%H:%M)] Step 1: generate-signal" | tee -a "$LOG"
npx tsx src/generate-signal.ts --output output 2>&1 | tee -a "$LOG"
echo "" | tee -a "$LOG"

# 2. 市場チェック (08:45 — mockでは即時実行)
echo "[$(date +%H:%M)] Step 2: check-market" | tee -a "$LOG"
npx tsx src/check-market.ts --output output 2>&1 | tee -a "$LOG"
echo "" | tee -a "$LOG"

# 3. 発注 — バスケットモード (09:10)
echo "[$(date +%H:%M)] Step 3: execute --basket" | tee -a "$LOG"
npx tsx src/execute.ts --output output --basket 2>&1 | tee -a "$LOG"
echo "" | tee -a "$LOG"

# 4. 手仕舞い (14:50 — mockでは --force で即時)
echo "[$(date +%H:%M)] Step 4: unwind --force" | tee -a "$LOG"
npx tsx src/unwind.ts --output output --force 2>&1 | tee -a "$LOG"
echo "" | tee -a "$LOG"

# 5. 日次レポート
echo "[$(date +%H:%M)] Step 5: daily-report" | tee -a "$LOG"
npx tsx src/daily-report.ts --output output 2>&1 | tee -a "$LOG"
echo "" | tee -a "$LOG"

# 6. 運用監視
echo "[$(date +%H:%M)] Step 6: run-monitor" | tee -a "$LOG"
npx tsx src/run-monitor.ts --output output 2>&1 | tee -a "$LOG"
echo "" | tee -a "$LOG"

echo "=== Pipeline complete: ${DATE} ===" | tee -a "$LOG"
