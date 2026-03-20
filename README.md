# turtle-gate

米国先行セクター情報 + LLMフィルター型 日本市場短期売買システム。

米国セクターETF 11銘柄の日次リターンから PCA_SUB モデルで日本 TOPIX-17 業種 ETF の売買シグナルを生成し、確信度デュアルバンド判定（P90 自動通過 / P80-P89 LLM審査 / P80未満 見送り）で取引日を選別する。当日引けで手仕舞いするデイトレード方式。

---

## セットアップ

```bash
npm install
```

データ取得（オプション、CSV を事前に用意する場合）:

```bash
python scripts/fetch-data.py
```

---

## 運用パイプライン

毎営業日、以下の順序で実行する。各ステップは独立した CLI で、前のステップの出力ファイルを入力にとる。

```
06:00  generate-signal   シグナル生成 + バンド判定 + LLM審査
08:45  check-market       リアルタイム気配取得 + 機械フィルター
09:10  execute            発注
14:50  unwind             手仕舞い
15:00  daily-report       日次統合レポート
15:05  run-monitor        運用監視 + ゲート/フェーズ判定
```

---

## コマンド一覧

### 1. generate-signal — シグナル生成

PCA_SUB モデルでシグナルを生成し、デュアルバンド確信度判定を行う。中確信バンド（P80-P89）の日は LLM が審査する。

```bash
npx tsx src/generate-signal.ts [options]
```

| オプション | デフォルト | 説明 |
|-----------|----------|------|
| `--start YYYY-MM-DD` | 1年前 | データ取得開始日 |
| `--end YYYY-MM-DD` | 今日 | データ取得終了日 |
| `--csv PATH` | — | CSV ファイルパス（省略時は Yahoo Finance API） |
| `--percentile N` | 90 | 高確信バンド閾値 |
| `--percentile-low N` | 80 | 中確信バンド下限閾値 |
| `--L N` | 60 | ローリングウィンドウ長（営業日） |
| `--K N` | 3 | 主成分数 |
| `--lambda N` | 0.9 | 正則化パラメータ |
| `--q N` | 0.3 | ロング/ショート選択割合 |
| `--phase PHASE` | normal | 運用フェーズ（後述） |
| `--output DIR` | output | 出力ディレクトリ |

**出力:**
- `output/signals.json` — 全日シグナル + 確信度 + 中間データ + LLM 入出力
- `output/latest-signal.txt` — 直近日の人間可読レポート
- `output/trade-days.txt` — 取引候補日一覧
- `output/trade-history.db` — SQLite に当日のシグナル結果を記録

**環境変数:**
- `LLM_PROVIDER=mock|openrouter` — LLM プロバイダ（デフォルト: mock）
- `OPENROUTER_API_KEY` — OpenRouter 利用時に必要
- `FINNHUB_API_KEY` — ニュース取得用（省略可）
- `PHASE=paper|p90_only|p90_plus_llm|normal` — `--phase` の代替

---

### 2. check-market — リアルタイム市場チェック

日本市場の寄り後にリアルタイム気配を取得し、一次機械フィルター（スプレッド・異常値・急変動・流動性）と寄り後方向維持チェックを実行する。

```bash
npx tsx src/check-market.ts [options]
```

| オプション | デフォルト | 説明 |
|-----------|----------|------|
| `--signal-file PATH` | output/signals.json | シグナルファイル |
| `--output DIR` | output | 出力ディレクトリ |
| `--check-time HH:MM` | 09:10 | 基準時刻（JST） |
| `--level2` | — | BrokerPort 経由で Level2 板情報を取得 |

**出力:**
- `output/market-check.json` — 気配値 + フィルター結果 + BBOスナップショット + 売買判定

**機械フィルターのチェック項目:**
1. 取引停止（出来高 0）
2. BBOスプレッド（Level2 → bid/ask → JPX基準の3段フォールバック）
3. 異常値（前日比 5% 超）
4. 直近急変動（10分間の max swing > 0.5%）
5. 流動性（Level2 板厚み、BrokerPort 接続時のみ）

---

### 3. execute — 発注

market-check.json の結果に基づき、全フィルター通過銘柄の発注を行う。

```bash
npx tsx src/execute.ts [options]
```

| オプション | デフォルト | 説明 |
|-----------|----------|------|
| `--market-check PATH` | output/market-check.json | 市場チェック結果 |
| `--output DIR` | output | 出力ディレクトリ |
| `--size JPY` | 1,000,000 | 1銘柄あたりのポジション金額 |

**ポジション制御:**
- 1銘柄: `POSITION_SIZE_JPY`（100万円）
- 売買総額上限: `MAX_TOTAL_POSITION_JPY`（1,000万円）
- 片側銘柄数上限: `MAX_SIDE_COUNT`（5銘柄）
- 市場休場時（marketState=CLOSED）は自動ブロック

**出力:**
- `output/execution-results.json` — 発注結果
- `output/trade-history.db` — SQLite にスプレッドコストを記録

**環境変数:**
- `BROKER_PROVIDER=mock|kabu` — ブローカー（デフォルト: mock = dry-run）
- `KABU_API_URL` — kabu Station API URL
- `KABU_API_PASSWORD` — kabu Station 認証パスワード

---

### 4. unwind — 手仕舞い

全ポジションを手仕舞いする。14:50-15:00 JST の時刻帯チェック付き。

```bash
npx tsx src/unwind.ts [options]
```

| オプション | デフォルト | 説明 |
|-----------|----------|------|
| `--output DIR` | output | 出力ディレクトリ |
| `--force` | — | 時刻帯チェックを無視して強制実行 |

**安全機能:**
- 非取引日（signals.json の判定が skip）にポジション残存があれば自動手仕舞い
- 時刻帯外は `--force` なしでは実行しない

**出力:**
- `output/unwind-results.json` — 手仕舞い結果
- `output/trade-history.db` — SQLite に実現リターンを記録

---

### 5. daily-report — 日次統合レポート

当日の全出力ファイルを1つの統合レポートにまとめる。

```bash
npx tsx src/daily-report.ts [--output DIR]
```

**出力:**
- `output/daily-report-YYYY-MM-DD.json` — 統合レポート

**含まれる情報:**
米国市場概況、シグナルレンジ・バンド判定、候補銘柄、LLM 判定結果（中確信のみ）、機械フィルター結果、BBOスナップショット、推定コスト、発注結果、手仕舞い結果

---

### 6. run-monitor — 運用監視

trade-history.db の蓄積データからシステムの健全性を評価する。

```bash
npx tsx src/run-monitor.ts [options]
```

| オプション | デフォルト | 説明 |
|-----------|----------|------|
| `--db PATH` | output/trade-history.db | SQLite ファイル |
| `--phase PHASE` | normal | 現在のフェーズ |
| `--output DIR` | output | 出力ディレクトリ |

**監視項目:**
- バンド別通過率（直近60日）
- LLM 判定品質（通過日 α > 15bps, 除外日 α < 10bps, 差 > 5bps）
- コスト控除後累積リターン推移（連続20営業日マイナスで halt）
- 月次スプレッド監視（12ヶ月平均 > 10bps → P85/P95 引上げ提案）
- Q5 vs Q1 モノトニシティ（Q5 < Q1 で halt）
- グロス R/R（3ヶ月連続 < 0.5 で Cfull 再検討推奨）

**ゲート条件（G1-G4）:**
- G1: JPX 12ヶ月MA スプレッド ≤ 10bps
- G2: ライブスプレッド / JPX 基準の乖離 ≤ 1.5倍
- G3: ペーパートレード 20営業日 + コスト控除後リターン > 0
- G4: 20営業日連続で異常なし

**推奨アクション:** `continue` / `degrade_to_p90` / `disable_llm` / `halt`

halt 時は exit code 1 を返す（cron 連携向け）。

**出力:**
- `output/monitor-report.json` — 監視レポート

---

### 7. backtest — バックテスト

過去データでの戦略評価。デュアルバンド対応。

```bash
npx tsx src/backtest.ts [options]
```

| オプション | デフォルト | 説明 |
|-----------|----------|------|
| `--csv PATH` | — | CSV ファイルパス（必須） |
| `--percentile N` | 90 | 高確信バンド閾値 |
| `--percentile-low N` | 80 | 中確信バンド下限閾値 |
| `--output DIR` | output | 出力ディレクトリ |

**出力内容:**
- バンド別成績（HIGH / MEDIUM / Combined）
- コスト感応度（0, 3, 5, 8, 10, 15 bps）
- 五分位分析（サブ期間別）
- OOS検証（IS:2015-2019 → OOS:2020-2025）
- 逆選択検証（Welch t検定）
- 年次パフォーマンス + OC/CC 比率
- アルファ減衰（Day 1-10）

---

## 運用フェーズ

`--phase` または `PHASE` 環境変数で段階的にリスクを上げていく。

| フェーズ | 構成 | LLM | 目的 |
|---------|------|:---:|------|
| `paper` | P80 全通過 | OFF | システム安定性・スプレッド検証 |
| `p90_only` | P90 のみ | OFF | 高確信バンド単体の実績確認 |
| `p90_plus_llm` | P90 + P80-P89 LLM審査 | ON | LLM 付加価値の検証 |
| `normal` | Phase 3 と同一 | ON | 通常運用 |

`run-monitor` が G1-G4 ゲート条件とフェーズ昇格判定を自動で行う。

---

## ブローカー接続

`BROKER_PROVIDER` 環境変数で切り替え。

| 値 | 説明 |
|----|------|
| `mock` (デフォルト) | dry-run。発注はコンソール出力のみ。ポジションはメモリ管理 |
| `kabu` | kabu Station API 接続。要 `KABU_API_URL` + `KABU_API_PASSWORD` |

mock で全パイプラインの動作確認が可能。本番接続時は `BROKER_PROVIDER=kabu` に切り替えるだけ。

---

## データストア

| ファイル | 形式 | 用途 |
|---------|------|------|
| `output/trade-history.db` | SQLite | 日次取引実績の蓄積。run-monitor の入力 |
| `output/signals.json` | JSON | シグナル + 確信度 + 中間データ |
| `output/market-check.json` | JSON | 気配 + フィルター + BBO |
| `output/*.json` | JSON | 各ステップの実行結果 |

trade-history.db は各 CLI ステップで自動更新される:
- `generate-signal` → band, signalRange, LLM judgment, phase
- `execute` → spreadCostBps, traded flag
- `unwind` → grossReturn, netReturn
