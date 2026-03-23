#!/bin/bash
# 日次ペーパートレード結果の自動レビュー
# daily-basket-paper.sh の後に実行し、Claude Code が結果を確認する
#
# Windowsタスクスケジューラから毎営業日 07:00 JST に実行

set -euo pipefail
cd "$(dirname "$0")/.."

DATE=$(date +%Y-%m-%d)
LOG="output/daily-log-${DATE}.txt"
SIGNALS="output/signals.json"
MARKET="output/market-check.json"
EXEC="output/execution-results.json"
MONITOR="output/monitor-report.json"

# ログが存在しない場合はパイプラインが未実行
if [ ! -f "$LOG" ]; then
  echo "No daily log found for ${DATE}. Pipeline may not have run."
  exit 0
fi

# Claude Code で結果をレビュー
claude -p "
あなたは turtle-gate の社長兼プロの投資家です。
今日 (${DATE}) のペーパートレード結果を確認し、簡潔なレポートを出してください。

確認すべきファイル:
1. output/daily-log-${DATE}.txt — パイプラインログ
2. output/signals.json — シグナル生成結果（latestDecision を確認）
3. output/market-check.json — 市場チェック結果
4. output/execution-results.json — 発注結果（存在する場合）
5. output/monitor-report.json — 運用監視レポート（存在する場合）
6. output/trade-history.db — 蓄積データ（SQLite）

レポート内容:
- 今日のバンド判定（HIGH/MEDIUM/LOW）とシグナルレンジ
- 発注があった場合: 銘柄、方向、VIXレジーム
- 異常の有無（エラー、欠損データ、halt推奨）
- trade-history.db の蓄積日数（B-6完了まであと何営業日か）
- 問題があれば次のアクションを提案

結果を標準出力に出力してください（ファイル保存はシェル側で行います）。
問題がなければ1段落で終わらせてOK。
" --allowedTools Read,Write,Bash,Glob 2>&1 | tee "output/daily-review-${DATE}.txt"
