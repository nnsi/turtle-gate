# turtle-gate

米国先行セクター情報 + LLMフィルター型 日本市場短期売買システム。

## プロジェクト概要

米国セクターETF 11銘柄の日次リターンから PCA_SUB モデルで日本 TOPIX-17 業種の売買シグナルを生成し、確信度フィルターで取引日を選別するデイトレードシステム。

**現在の戦略方針**: ETFではなく**個別株バスケット**（各セクター上位3銘柄）で執行する。PTS前倒し執行でOC/CC比率を改善し、年利30%を目指す。

## 進行状況

タスクリスト: `docs/tasklist.md`（信頼できる唯一のソース）
戦略提言: `docs/strategy-recommend-1.md`

### 完了済み
- **Phase A**: 検証完了。Go判定（2026-03-22）
  - バスケットα=68.7bps (t=6.40)、ETFの136%。アルファは増幅される
  - PTS流動性: 6セクターOK、4注意、5困難、2不可
- **Phase B**: 実装完了（B-1〜B-5）。`--basket`フラグで個別株執行が可能
  - `src/basket.ts`, `src/execute-helpers.ts`, `src/backtest-basket.ts` が新規

### 進行中
- **B-6**: ペーパートレード20営業日（Windowsタスクスケジューラで毎朝06:00自動実行中）
  - タスク名: `turtle-gate-paper`
  - ログ: `output/daily-log-YYYY-MM-DD.txt`
  - 実績DB: `output/trade-history.db`

### 未着手
- **Phase C**: PTS執行（A-2の板実測が前提）
- **Phase D**: レバレッジ
- **Phase E**: LLM実働化（Phase C安定後まで後ろ倒し）
- **Phase F**: 追加アルファ源

## 重要な意思決定履歴

1. **ETF→個別株バスケット**: TE（トラッキングエラー）は13-21%と高いが、アルファは生き残り増幅される。TEの高さは問題にならない
2. **LLM後ろ倒し**: 執行改革（+10-15%）が先、LLM（+3-5%）は後。新システムのベースラインが確定してから載せる
3. **Go/No-Go基準改訂**: 当初の「相関0.90 & TE10%以下」→「バスケットα > 15bps & t > 2.0」に変更

## 技術スタック

- TypeScript (tsx), Node.js
- SQLite (trade-history.db)
- Python (yfinance, numpy, scipy — 分析スクリプト)
- Yahoo Finance API / kabu Station API
- BrokerPort DI (mock/kabu/将来PTS)

## ファイル構成の要点

- `src/basket.ts` — セクター→個別株マッピング、PTS分類
- `src/execute.ts` + `src/execute-helpers.ts` — 発注（`--basket`対応）
- `src/backtest.ts` + `src/backtest-basket.ts` — バックテスト（`--basket`対応）
- `src/signal.ts` + `src/signal-pca-sub.ts` — PCA_SUBシグナル生成
- `scripts/daily-basket-paper.sh` — 日次自動パイプライン
- `docs/tasklist.md` — 全タスクの進捗管理

## コーディングルール

- 1ファイル200行以内
- `type` を使う（`interface` ではない）
- APIパス末尾スラッシュなし
- DB: SQLite (trade-history.db), Neon Postgres は使わない
- 古いファイルは削除（再エクスポートとして残さない）
