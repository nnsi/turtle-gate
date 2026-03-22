# Windowsタスクスケジューラ設定手順

## 概要

`scripts/daily-basket-paper.sh` を毎営業日自動実行し、B-6（ペーパートレード20営業日）を無人で回す。

## PowerShellでタスク登録（管理者権限不要）

```powershell
$action = New-ScheduledTaskAction `
  -Execute "C:\Program Files\Git\bin\bash.exe" `
  -Argument "-c 'cd /d/workspace/turtle-gate && bash scripts/daily-basket-paper.sh'" `
  -WorkingDirectory "D:\workspace\turtle-gate"

$trigger = New-ScheduledTaskTrigger -Daily -At 06:00

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask `
  -TaskName "turtle-gate-paper" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "turtle-gate daily basket paper trade pipeline"
```

## 確認

```powershell
Get-ScheduledTask -TaskName "turtle-gate-paper"
```

## 手動実行（テスト）

```powershell
Start-ScheduledTask -TaskName "turtle-gate-paper"
```

## 削除

```powershell
Unregister-ScheduledTask -TaskName "turtle-gate-paper" -Confirm:$false
```

## 注意事項

- PCがスリープ中は実行されない。「スリープ解除して実行」を有効にする場合はタスクのプロパティから設定
- 休日（土日祝）も実行されるが、シグナル生成が0件で終了するだけなので無害
- ログは `output/daily-log-YYYY-MM-DD.txt` に保存される
- 20営業日分のログが溜まったら B-6 完了。結果は `output/trade-history.db` に蓄積される
