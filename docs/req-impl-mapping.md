# 要求定義書 ↔ 実装 対応マッピング

## 凡例

- **◯ 実装済み**: 機能が実装されている
- **△ 部分実装**: コア部分は実装済みだが一部未対応
- **✕ 未実装**: 今回のスコープ外

---

## 8.1 市場データ取得機能

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| 8.1.1 米国セクターETF 11銘柄取得 | ◯ | `src/config.ts` US_TICKERS | XLB～XLY |
| 8.1.1 日本TOPIX-17 ETF取得 | ◯ | `src/config.ts` JP_TICKERS | 1617.T～1633.T |
| 8.1.1 米国主要指数・金利・為替等 | ◯ | `src/market-context.ts` | SPY, VIX, US10Y, USDJPY, DXY |
| 8.1.1 ニュース・経済情報（LLM入力用） | ◯ | `src/news.ts` fetchMarketNews | Finnhub(EN)+Google News RSS(JP) |
| 8.1.1 寄り前・寄り後の板情報 | ◯ | `src/broker.ts` getLevel2Quotes, `src/check-market.ts` | BrokerPort経由。BBOスナップショット保存 |
| 8.1.2 取得失敗時リトライ | ◯ | `src/data.ts` fetchTickerPrices | 最大3回リトライ |
| 8.1.2 データ欠損検知・当日見送り | ◯ | `src/data.ts` buildReturnMatrix | sparse mode対応 |
| 8.1.2 過去60営業日ローリングウィンドウ保持 | ◯ | `src/signal.ts` generateSignals | L=60 |
| 8.1.2 XLC/XLRE動的ユニバース縮小 | ◯ | `src/signal.ts` generateSignalForDate | ウィンドウ内NaN/Cfull欠損ティッカーを動的除外 |

---

## 8.2 数値シグナル生成機能（PCA_SUB）

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| 8.2.1 PCA_SUB全ステップ | ◯ | `src/signal.ts`, `src/linalg.ts` | 標準化→Ct→C0→正則化→固有値→ファクタースコア→シグナル復元 |
| 8.2.1 事前部分空間 (v1,v2,v3) | ◯ | `src/signal.ts` buildPriorSubspace | グローバル/国スプレッド/シクリカル-ディフェンシブ |
| 8.2.1 上位30%ロング/下位30%ショート | ◯ | `src/signal.ts` selectCandidates | q=0.3 |
| 8.2.1 Cfull更新ポリシー | ◯ | `src/cfull-monitor.ts` | Frobenius距離/固有値シフト/部分空間角度 + R/R 3ヶ月連続<0.5 + Q5<Q1モノトニシティ崩壊 |
| 8.2.2 中間データ保存 (§14) | ◯ | `src/signal.ts` IntermediateData | Creg対角/固有値/固有ベクトル/使用銘柄数をSignalResultに含む |
| 8.2.3 パラメータ外部設定 | ◯ | `src/config.ts` SignalParams | CLI引数で変更可能 |
| 8.2.3 再現性 | ◯ | — | 乱数不使用。決定的計算 |

---

## 8.3 デュアルバンド確信度判定機能

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| 8.3.3 P90/P80デュアルバンド判定 | ◯ | `src/signal.ts` applyDualBandFilter | 拡張ウィンドウ方式（look-ahead回避） |
| 8.3.4 閾値設定可能 | ◯ | `src/generate-signal.ts` | --percentile, --percentile-low |
| 8.3.4 バンド判定結果保存 | ◯ | `src/generate-signal.ts` | signals.json に confidence 含む |

---

## 8.4 一次機械フィルター機能

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| 8.4.1 BBOスプレッド判定 | ◯ | `src/mechanical-filter.ts` checkTicker | Level2→bid_ask→JPX基準の3段フォールバック |
| 8.4.1 流動性条件 | ◯ | `src/mechanical-filter.ts` | Level2板厚み判定。BrokerPort経由 |
| 8.4.1 異常値・売買停止検出 | ◯ | `src/mechanical-filter.ts` | 前日比5%超→異常値、出来高0→停止 |
| 8.4.1 直近急変動検出 | ◯ | `src/realtime.ts` detectRecentVolatility | 直近10分max swing |
| 8.4.2 銘柄別スプレッド基準値 | ◯ | `src/config.ts` BBO_SPREAD_THRESHOLDS | JPX月次17銘柄別 |
| 8.4.3 09:10 BBO記録 | ◯ | `src/check-market.ts` bboSnapshot | タイムスタンプ付きBBOスナップショットをJSON保存 |
| 8.4.3 見送り理由保存 | ◯ | `src/mechanical-filter.ts` FilterResult.reasons | 配列で保持 |

---

## 8.5 LLM情報整理・信用判定機能

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| 8.5.1 中確信バンドのみLLM審査 | ◯ | `src/trade-decision.ts` | medium bandのみLLM呼び出し |
| 8.5.2 ニュース要約・セクター関連性 | ◯ | `src/news.ts`, `src/llm.ts` | Finnhub+Google News RSS |
| 8.5.2 イベント支配日の判定補助 | ◯ | `src/llm.ts` | eventDominanceフラグでLLMが判定 |
| 8.5.5 出力: 判定カテゴリ+理由+ニュース要約+リスク+イベント支配 | ◯ | `src/llm.ts` LLMResult | judgment/summary/newsSummary/riskFactors/eventDominance |
| 8.5.6 構造化JSON出力 | ◯ | `src/llm.ts` | mock/OpenRouter両対応 |
| 8.5.6 入力と出力の追跡可能 | ◯ | `src/llm.ts` LLMResult.rawPrompt | プロンプト全文+rawResponse保存 |

---

## 8.6 最終売買判定機能

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| 8.6.1 高確信→自動通過→執行 | ◯ | `src/trade-decision.ts` | normal size |
| 8.6.1 中確信→LLM→サイズ決定 | ◯ | `src/trade-decision.ts` | tailwind:1.0/neutral:0.5/headwind:skip |
| 8.6.1 低確信→見送り | ◯ | `src/trade-decision.ts` | skip |
| 8.6.1 全体イベント支配→当日全停止 | ◯ | `src/trade-decision.ts` | eventDominance=true→全停止（§11.3） |
| 8.6.2 見送り理由・サイズ決定保存 | ◯ | `src/trade-decision.ts` | skipReason/size/sizeMultiplier |

---

## 8.7-8.9 寄り後価格確認・発注・手仕舞い

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| 8.7.1-8.7.2 寄り後確認 | ◯ | `src/post-open-check.ts` | 方向維持/BBO/急変動 |
| 8.8 発注機能 | ◯ | `src/execute.ts` | BrokerPort.placeOrder。売買量制御(§12.1)付き |
| 8.9 手仕舞い（14:50-15:00） | ◯ | `src/unwind.ts` | closeAllPositions。時刻帯チェック+--force |
| 8.9 非取引日フラットポジション | ◯ | `src/unwind.ts` checkNonTradeDay | skip日にポジション残存→自動手仕舞い |

---

## 8.10 ログ・監査機能

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| 8.10.1 シグナル・バンド・LLM入出力保存 | ◯ | `src/generate-signal.ts` | signals.json (intermediateData/rawPrompt含む) |
| 8.10.1 機械フィルター結果保存 | ◯ | `src/check-market.ts` | market-check.json (bboSnapshot含む) |
| 8.10.1 発注・手仕舞い結果保存 | ◯ | `src/execute.ts`, `src/unwind.ts` | execution/unwind-results.json |
| 8.10.1 人間可読ログ | ◯ | `src/format-signal.ts` | latest-signal.txt |

---

## §9 非機能要件

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| 9.5 LLM応答異常→中確信全見送り | ◯ | `src/trade-decision.ts` | try-catch→skip。高確信は影響なし |

---

## §11 判定設計方針

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| 11.3 イベント支配→高確信含む全停止 | ◯ | `src/llm.ts` eventDominance, `src/trade-decision.ts` | LLMがeventDominance=true→全停止フラグ伝播 |

---

## §12 リスク管理要件

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| 12.1 売買量制御 | ◯ | `src/execute.ts`, `src/config.ts` | POSITION_SIZE_JPY=1M, MAX_TOTAL=10M, MAX_SIDE_COUNT=5 |
| 12.3 累積コスト計算 | ◯ | `src/monitor.ts` cumulativeReturn | gross/net追跡 |
| 12.3 月次スプレッド監視→P85/P95引上げ | ◯ | `src/monitor.ts` spreadMonitor | 12ヶ月平均>10bps→shouldUpgrade=true |
| 12.4 運用停止条件 | ◯ | `src/monitor.ts` | 累積リターン連続20営業日マイナス→halt |

---

## §13 LLM利用方針

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| 13.3 LLM判定品質評価 | ◯ | `src/monitor.ts` llmQuality | 通過日α>15bps, 除外日α<10bps, 差>5bps |
| 13.3 品質基準未達→LLM無効化 | ◯ | `src/monitor.ts` | meetsThreshold=false→disable_llm推奨 |

---

## §14 データ保存要件

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| 中間データ（相関行列・固有ベクトル） | ◯ | `src/signal.ts` IntermediateData | signals.jsonに保存 |
| LLM入出力追跡 | ◯ | `src/llm.ts` rawPrompt/rawResponse | signals.json経由 |

---

## §15 バックテスト・検証要件

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| 15.1 コスト控除前後の成績 | ◯ | `src/backtest-report.ts` | 0/3/5/8/10/15 bps |
| 15.1 高確信/中確信バンド別単体成績 | ◯ | `src/backtest-report.ts` | applyDualBandFilter使用。HIGH/MEDIUM/Combined |
| 15.1 五分位分析（サブ期間別） | ◯ | `src/backtest-analysis.ts` | 3期間 |
| 15.1 OOS検証 | ◯ | `src/backtest-analysis.ts` | IS:2015-2019→OOS:2020-2025 |
| 15.1 逆選択検証 | ◯ | `src/backtest-analysis.ts` | |return|をproxy spread、High/All・Trade/All比+Welch t検定 |
| 15.1 年次パフォーマンス + OC/CC比率 | ◯ | `src/backtest-analysis.ts` | 年次別OC/CC Ratio列 |
| 15.1 アルファ減衰（Day 1-10） | ◯ | `src/backtest-analysis.ts` | |

---

## §17 想定画面・出力イメージ

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| 17.1 日次判定レポート | ◯ | `src/daily-report.ts` | signals+market-check+execution+unwind統合。daily-report-YYYY-MM-DD.json |
| 17.2 運用監視 | ◯ | `src/monitor.ts` computeMonitorReport | バンド別通過率/LLM品質/累積リターン/異常検知 |

---

## §19 初期リリース範囲

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| 19.2 ゲート条件 G1-G4 | ◯ | `src/gate.ts` checkGates | G1:スプレッド/G2:ライブ乖離/G3:ペーパートレード/G4:安定性 |
| 19.3 段階的フォワード Phase 1-4 | ◯ | `src/gate.ts` getPhaseConfig, shouldAdvancePhase | paper→p90_only→p90_plus_llm→normal |
| 19.3 Phase統合 | ◯ | `src/generate-signal.ts` | --phase CLI + PHASE env var。Phase別にpercentile/LLM自動制御 |

---

## 付録D

| 要件 | 状態 | 実装箇所 | 備考 |
|------|------|---------|------|
| D.3 Q5 < Q1 → 取引停止 | ◯ | `src/monitor.ts`, `src/cfull-monitor.ts` | 60日ローリングQ5/Q1 + monotonicityCheck |

---

## 出力ファイル一覧

| ファイル | 内容 | 対応要件 |
|---------|------|---------|
| `output/signals.json` | 全日シグナル＋確信度＋中間データ＋LLM入出力 | 8.2, 8.3, 8.10, 14 |
| `output/latest-signal.txt` | 直近日シグナルレポート（人間可読） | 8.10, 17.1 |
| `output/trade-days.txt` | 取引候補日一覧 | 8.3.4 |
| `output/market-check.json` | 気配＋機械フィルター＋BBOスナップショット | 8.4, 8.7, 8.10 |
| `output/execution-results.json` | 発注結果 | 8.8, 8.10 |
| `output/unwind-results.json` | 手仕舞い結果 | 8.9, 8.10 |
| `output/daily-report-YYYY-MM-DD.json` | 日次統合レポート | 17.1 |

---

## パラメータ対応表

| パラメータ | 要求値 | 実装値 | 定義箇所 |
|----------|-------|-------|---------|
| L (ローリングウィンドウ) | 60 | 60 | `src/config.ts` |
| K (主成分数) | 3 | 3 | `src/config.ts` |
| λ (正則化) | 0.9 | 0.9 | `src/config.ts` |
| q (ロング/ショート閾値) | 0.3 | 0.3 | `src/config.ts` |
| 確信度パーセンタイル（高） | P90 | P90 (変更可) | CLI --percentile |
| 確信度パーセンタイル（中下限） | P80 | P80 (変更可) | CLI --percentile-low |
| 1ポジション金額 | — | ¥1,000,000 | `src/config.ts` POSITION_SIZE_JPY |
| 売買総額上限 | — | ¥10,000,000 | `src/config.ts` MAX_TOTAL_POSITION_JPY |
| 片側銘柄数上限 | — | 5 | `src/config.ts` MAX_SIDE_COUNT |

---

## ソースファイル一覧

| ファイル | 行数 | 役割 |
|---------|------|------|
| `src/config.ts` | 162 | 設定・定数・銘柄表示名 |
| `src/data.ts` | 357 | データ取得・CSV読込 |
| `src/linalg.ts` | 150 | 線形代数（相関行列・固有値） |
| `src/signal.ts` | 433 | PCA_SUBシグナル生成・確信度フィルター |
| `src/signal-pca-sub.ts` | 138 | PCA_SUBプロバイダー（SignalProvider DI） |
| `src/signal-provider.ts` | 90 | SignalProviderインターフェース・DI |
| `src/realtime.ts` | 170 | Yahoo Finance リアルタイム取得 |
| `src/mechanical-filter.ts` | 176 | 一次機械フィルター |
| `src/post-open-check.ts` | 121 | 寄り後価格確認 |
| `src/llm.ts` | 275 | LLM判定（mock/OpenRouter） |
| `src/news.ts` | 212 | ニュース取得（Finnhub/Google RSS） |
| `src/market-context.ts` | 144 | 米国指標取得 |
| `src/trade-decision.ts` | 216 | 最終売買判定 |
| `src/broker.ts` | 109 | BrokerPort（DI境界） |
| `src/broker-mock.ts` | 145 | Mock broker |
| `src/broker-kabu.ts` | 171 | kabu Station adapter |
| `src/basket.ts` | 113 | セクター→個別株バスケット変換 |
| `src/execute.ts` | 169 | 発注CLI（§8.8、--basket対応） |
| `src/execute-helpers.ts` | 131 | 発注ヘルパー（候補解決・バスケット展開） |
| `src/unwind.ts` | 199 | 手仕舞いCLI（§8.9、バスケット表示対応） |
| `src/monitor.ts` | 177 | 運用監視（§12/§13/§17.2/D.3） |
| `src/gate.ts` | 180 | ゲート条件・フェーズ管理（§19） |
| `src/cfull-monitor.ts` | 159 | Cfullドリフト+R/R+モノトニシティ |
| `src/daily-report.ts` | 196 | 日次統合レポート（§17.1） |
| `src/generate-signal.ts` | 195 | シグナル生成CLI（エントリーポイント） |
| `src/format-signal.ts` | 64 | シグナルレポートフォーマッタ |
| `src/check-market.ts` | 223 | 市場チェックCLI |
| `src/backtest.ts` | 198 | バックテストCLI（--basket対応） |
| `src/backtest-basket.ts` | 156 | バスケットバックテストヘルパー |
| `src/backtest-report.ts` | 190 | バックテスト成績レポート |
| `src/backtest-analysis.ts` | 231 | 五分位・逆選択・年次分析 |
| `src/trade-history.ts` | 229 | SQLite永続化 |
| `src/run-monitor.ts` | 245 | 運用監視CLI |
