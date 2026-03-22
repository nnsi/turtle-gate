# turtle-gate

米国先行セクター情報 + LLMフィルター型 日本市場短期売買システム。

## プロジェクト概要

米国セクターETF 11銘柄の日次リターンから PCA_SUB モデルで日本 TOPIX-17 業種の売買シグナルを生成し、確信度フィルターで取引日を選別するデイトレードシステム。

**現在の戦略方針**: ETFではなく**個別株バスケット**（各セクター上位3銘柄）で執行する。OCベースNet AR 30%を目指すが、改善しない構成は早く棄却する。

## 進行状況

タスクリスト: `docs/tasklist.md`（信頼できる唯一のソース）

### 完了済み
- **Phase A**: 検証完了。条件付きGo判定（2026-03-22）
  - バスケットα=72.7bps (t=6.52)、ETFの143%。ただし別戦略化リスクあり
  - PTS流動性: 6セクターOK、4注意、5困難、2不可
- **Phase B**: 実装完了（B-1〜B-5）。`--basket`フラグで個別株執行が可能

### 進行中
- **B-6**: ペーパートレード20営業日（Windowsタスクスケジューラで毎朝06:00自動実行中）
  - タスク名: `turtle-gate-paper`
  - ログ: `output/daily-log-YYYY-MM-DD.txt`
  - 実績DB: `output/trade-history.db`
  - Kill基準・構造化ログ・Go条件は `docs/tasklist.md` B-6 に定義

### 未着手
- **Phase C**: 執行最適化（時刻最適化、執行ルール整備）
- **Phase D**: LLM実働化（強制除外のみ、P90帯は触らない）
- **Phase E**: PTS執行（観測先行、限定導入から）
- **Phase F**: 追加アルファ源
- **Phase G**: レバレッジ導入（最終段階、無レバNet AR 15%以上が前提）

## 重要な意思決定履歴

1. **ETF→個別株バスケット**: TE（トラッキングエラー）は13-21%と高いが、アルファは生き残り増幅される。ただし「別戦略化」のリスクを含む（外部レビュー指摘）
2. **LLM後ろ倒し**: 執行改革が先、LLM（+3-5%）は後。ベースライン確定後に載せる
3. **Go/No-Go基準改訂**: 当初の「相関0.90 & TE10%以下」→「バスケットα > 15bps & t > 2.0」に変更。条件付きGo（ペーパートレード検証付き）
4. **レバレッジ最終段階化**: 無レバNet AR 15%以上 + 3ヶ月安定運用が前提条件（外部レビュー採用）
5. **計測基準をOCベースに変更**: CCは参考値。実約定近似で評価する（外部レビュー採用）

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
