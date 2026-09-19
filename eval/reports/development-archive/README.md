# 開發期原始紀錄

這裡保留收緊來源 provenance 規則前的原始 live 報告。內含 5 份 artifact 的 DecisionSignal evidenceIds metadata 不符合最終驗證器，不能宣稱是現行可驗證／可匯入執行包。

上層同名報告中的對應 artifact 為明示的 recorded-live 子 run，保留 parentRunId、變更原因、原始請求／回應／transport。離線重算只更正哪些來源實際进入請求的 metadata，沒有新模型呼叫，沒有更改政策或模型答案。原推論延遲及失敗保留；雜湊不證明來源真實。

舊 eval-v1 的 frozenAt 時區標記有誤，不能用這個時間證明事前凍結；這些紀錄只屬開發 smoke，非正式 held-out 模型品質證據。詳見 [交付驗證](../../../docs/workbench-verification.md)。
