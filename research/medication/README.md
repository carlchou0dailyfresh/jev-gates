# Medication five-arm study / 用藥資訊安全分流研究

**2026-09-22 狀態：A／B 真實開發集測試已完成與核對；C／D／E、OCR 和臨床驗證尚未完成。**

本研究比較 A：LLM only、B：LLM + RAG、C：LLM + Laya、D：LLM + 官方 Jev、E：LLM + Laya + Jev consensus。
只有 B 取得檢索資料；本研究不把 LocalJev 當官方 Jev，不把工程模擬當真實模型結果。

## 最新結果

使用者在 Mac 以 `gemma3:27b` 跑了 8 個合成開發案例，各跑 A／B 一次，共 16 筆真實回應。
兩組原始分流皆為 8／8 符合暫定參考標籤，B 平均耗時 5.75 秒，A 為 4.39 秒。
16 份模型草稿全部是英文，未遵守繁體中文要求；A 有一筆引用 namespace 違規。
**沒有證據可據此宣稱 RAG 提高正確率、五組模型優劣或臨床安全。**

完整結果、逐筆資料、限制與原始雜湊見 [A／B 實測報告](results/2026-09-22-gemma3-ab/README.md)。

## 方法與歷史

完整的五組配置、路由政策、API／Laya 設定、原始評分方法與來源，保留在
[凍結的 v0.1 研究協定](README.protocol-v0.1.md)。其中「尚無 live 結果」描述初始工程交付當時，
不是最新狀態。原工程報告亦保留為 [歷史紀錄](../../docs/medication-engineering-2026-09-22.md)，
沒有用新數字覆寫或假冒舊測試結果。

## 重算已發布的實測摘要

不需模型或金鑰，Python 使用標準函式庫：

```bash
python3 research/medication/review_results.py \
  --input research/medication/results/2026-09-22-gemma3-ab/observations.json \
  --check research/medication/results/2026-09-22-gemma3-ab/analysis.json
```

保有原始 ZIP 時，可用 `--archive /path/to/jev-medication-AB-20260922-160621.zip` 取代 `--input`，
重新核對原始檔案雜湊、逐筆 raw responses 與報表。新加入的 `tests/medication-imported-results.test.mjs`
納入既有 `npm test`；無 Python 時，Python 專屬測試會明確標為 skipped。

## 執行框架工程測試

```bash
npm ci
npm run medication:test
npm run medication:fixture -- --out .jev-medication-runs/fixture-001
npm run medication:verify -- --verify .jev-medication-runs/fixture-001
```

本次 Mac 實測使用了另行交付的本機 Ollama adapter 修補，因此與 manifest 相符的五個執行檔另外凍結於
`results/2026-09-22-gemma3-ab/execution/`。本次提交沒有更換根目錄的實驗 prompt 或 runtime，
也沒有把本機啟動套件默默合併成另一套研究版本。完整原始報告的離線重播請依實測報告使用凍結快照。

本模組不提供個人停藥、調劑量或治療決策。模型草稿供研究覆核，不可因為分流符合標籤就直接提供病人使用。
