# turtle-gate

米国先行セクター情報を用いた日本市場短期売買システム。

PCA_SUB モデルで米国セクターETF 11銘柄の日次リターンから日本市場の売買シグナルを生成し、**個別株バスケット**（各セクター上位3銘柄）で執行する。確信度フィルターで取引日を選別し、当日引けで手仕舞いするデイトレード方式。

---

## 戦略の概要

```
米国市場終了 → PCA_SUBシグナル生成 → 確信度フィルター → 個別株バスケットに展開 → 執行 → 引け手仕舞い
```

**アルファの源泉**: 米国セクター→日本業種間のリードラグ（1日遅れの伝播）を PCA_SUB で捕捉。Day 1 CC α = 21.9bps (t=10.06)。

**なぜ個別株バスケットか**: TOPIX-17 セクターETFは流動性が低く（日次出来高 ¥1,100万-¥6,700万）、PTS取引実績ゼロ。個別株（トヨタ、三菱UFJ等）なら PTS で前倒し執行でき、OC/CC 比率を改善できる。バックテストではバスケット執行のアルファが ETF の 143% に増幅される（P90 α=72.7bps, t=6.52）。

---

## セットアップ

```bash
npm install
```

データ取得（オプション）:

```bash
python scripts/fetch-data.py
```

---

## 運用パイプライン

### ETFモード（従来）

```
06:00  generate-signal   シグナル生成 + バンド判定
08:45  check-market       リアルタイム気配取得 + 機械フィルター
09:10  execute            発注（セクターETF）
14:50  unwind             手仕舞い
15:00  daily-report       日次統合レポート
15:05  run-monitor        運用監視 + ゲート/フェーズ判定
```

### バスケットモード（新）

```
06:00  generate-signal   シグナル生成 + バンド判定
08:45  check-market       リアルタイム気配取得 + 機械フィルター
09:10  execute --basket   発注（個別株バスケット）
14:50  unwind             手仕舞い（個別株ポジション自動検出）
15:00  daily-report       日次統合レポート
15:05  run-monitor        運用監視 + ゲート/フェーズ判定
```

### 自動実行

```bash
bash scripts/daily-basket-paper.sh
```

Windowsタスクスケジューラへの登録手順は `scripts/setup-task-scheduler.md` を参照。

---

## コマンド一覧

### generate-signal — シグナル生成

PCA_SUB モデルでシグナルを生成し、デュアルバンド確信度判定を行う。

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
| `--phase PHASE` | normal | 運用フェーズ |
| `--output DIR` | output | 出力ディレクトリ |

### check-market — リアルタイム市場チェック

寄り後にリアルタイム気配を取得し、一次機械フィルター（スプレッド・異常値・急変動・流動性）を実行する。

```bash
npx tsx src/check-market.ts [--signal-file PATH] [--output DIR] [--check-time HH:MM] [--level2]
```

### execute — 発注

market-check.json の結果に基づき発注する。`--basket` で個別株バスケット執行。

```bash
npx tsx src/execute.ts [--market-check PATH] [--output DIR] [--size JPY] [--basket]
```

| オプション | デフォルト | 説明 |
|-----------|----------|------|
| `--market-check PATH` | output/market-check.json | 市場チェック結果 |
| `--size JPY` | 1,000,000 | 1セクターあたりのポジション金額 |
| `--basket` | — | 個別株バスケットモード |

バスケットモードでは、セクター候補を `basket.ts` の定義に従い個別株に展開する。各銘柄はセクター金額の 1/3 を受け取る。

### unwind — 手仕舞い

全ポジションを手仕舞いする。バスケットポジションはセクター別にグループ表示。

```bash
npx tsx src/unwind.ts [--output DIR] [--force]
```

### daily-report — 日次統合レポート

```bash
npx tsx src/daily-report.ts [--output DIR]
```

### run-monitor — 運用監視

```bash
npx tsx src/run-monitor.ts [--db PATH] [--phase PHASE] [--output DIR]
```

### backtest — バックテスト

```bash
npx tsx src/backtest.ts --csv data/closes.csv [--percentile 90] [--basket --stocks-csv data/stocks.csv]
```

| オプション | デフォルト | 説明 |
|-----------|----------|------|
| `--csv PATH` | — | ETF価格CSV（必須） |
| `--percentile N` | 90 | 高確信バンド閾値 |
| `--basket` | — | バスケットリターンで評価 |
| `--stocks-csv PATH` | — | 個別株価格CSV（`--basket` 時必須） |

---

## 個別株バスケット

### セクター → 銘柄マッピング（`src/basket.ts`）

各 TOPIX-17 セクターの時価総額上位3銘柄で構成。均等加重（各 1/3）。

| セクター | ETF | 銘柄1 | 銘柄2 | 銘柄3 | PTS |
|---------|-----|-------|-------|-------|:---:|
| 食品 | 1617.T | JT | 味の素 | アサヒGHD | B |
| エネルギー | 1618.T | ENEOS | INPEX | 出光興産 | A |
| 建設・資材 | 1619.T | 大和ハウス | 積水ハウス | 鹿島建設 | C |
| 素材・化学 | 1620.T | 信越化学 | 富士フイルム | 花王 | B |
| 医薬品 | 1621.T | 武田薬品 | 第一三共 | 中外製薬 | C |
| 自動車 | 1622.T | トヨタ | ホンダ | デンソー | A |
| 鉄鋼・非鉄 | 1623.T | 日本製鉄 | 住友電工 | フジクラ | B |
| 機械 | 1624.T | 三菱重工 | コマツ | ダイキン | A |
| 電機・精密 | 1625.T | ソニーG | 日立 | 東京エレクトロン | B |
| 情報通信 | 1626.T | 任天堂 | リクルート | SBG | A |
| 電気・ガス | 1627.T | 東京ガス | 関西電力 | 大阪ガス | D |
| 運輸・物流 | 1628.T | JR東日本 | JR東海 | 日本郵船 | C |
| 商社・卸売 | 1629.T | 三菱商事 | 伊藤忠 | 三井物産 | A |
| 小売 | 1630.T | ファストリ | セブン&アイ | イオン | D |
| 銀行 | 1631.T | 三菱UFJ | 三井住友FG | みずほFG | A |
| 金融(除銀行) | 1632.T | 東京海上 | MS&AD | SOMPO | C |
| 不動産 | 1633.T | 三井不動産 | 三菱地所 | 住友不動産 | C |

**PTS分類**: A=PTS執行可、B=条件付き、C=困難、D=不可

---

## 運用フェーズ

| フェーズ | 構成 | LLM | 目的 |
|---------|------|:---:|------|
| `paper` | P80 全通過 | OFF | システム安定性・スプレッド検証 |
| `p90_only` | P90 のみ | OFF | 高確信バンド単体の実績確認 |
| `p90_plus_llm` | P90 + P80-P89 LLM審査 | ON | LLM 付加価値の検証 |
| `normal` | Phase 3 と同一 | ON | 通常運用 |

---

## ブローカー接続

`BROKER_PROVIDER` 環境変数で切り替え。

| 値 | 説明 |
|----|------|
| `mock` (デフォルト) | dry-run。発注はコンソール出力のみ |
| `kabu` | kabu Station API 接続 |

---

## バックテスト成績（2015-2025）

### ETF執行

| フィルター | 取引日/年 | Gross AR | R/R | MDD | BE(bps) |
|-----------|---------|---------|-----|-----|---------|
| P75 | 394 | 12.6% | 2.16 | -5.1% | 11.0 |
| P90 | 161 | 7.8% | 1.80 | -3.7% | 16.6 |

### バスケット執行（EW-3, CC returns）

| フィルター | α(bps/day) | t値 | AR% | R/R |
|-----------|-----------|-----|-----|-----|
| P90 | 72.7 | 6.52 | 183.1 | 9.04 |
| P75 | 47.9 | 8.50 | 120.6 | 7.38 |

バスケット執行はETFの143%のアルファを示す。セクター内大型株がリードラグシグナルに対してETFより高い感応度を持つため。

---

## データストア

| ファイル | 形式 | 用途 |
|---------|------|------|
| `output/trade-history.db` | SQLite | 日次取引実績の蓄積 |
| `output/signals.json` | JSON | シグナル + 確信度 |
| `output/market-check.json` | JSON | 気配 + フィルター |
| `output/daily-log-YYYY-MM-DD.txt` | Text | 日次パイプラインログ |

---

## ドキュメント

| ファイル | 内容 |
|---------|------|
| `docs/require.md` | 要求定義書（原本） |
| `docs/tasklist.md` | 全タスクの進捗管理 |
| `docs/basket-candidates.md` | セクター別バスケット候補とPTS流動性データ |
| `docs/req-impl-mapping.md` | 要求 ↔ 実装の対応表 |
