# 台灣 ETF 觀測儀表板

每日自動抓取台股加權指數（大盤，含近 30 個交易日走勢圖）、追蹤清單資料與三大法人（外資/投信/自營商）
買賣超，計算技術指標（MA / RSI / MACD），並以可解釋的規則式評分（趨勢 + 動能 + 大戶買賣）產生多空
傾向分數。首頁分三區：

- **今日偏多觀察名單**：每天自動算分篩出來的（分數 ≥30，最多 10 檔，來源是下面兩區 + 自訂新增的全部）。
- **我的關注清單**：固定不變，只有原本的 7 檔 ETF + 自己手動新增的股票（含從產業觀察清單「加入關注」的）。
- **產業觀察清單**：半導體/電子 + 金融/高股息主題共 15 檔候選股票，每天依分數排序只顯示前 10 名，
  這區內容本身會隨每天分數變動；看到喜歡的可以點「＋加入關注」把它固定移到「我的關注清單」。

手動新增/加入關注的股票即時用瀏覽器抓資料計算，只存在自己裝置上（localStorage），不影響每日排程的
追蹤清單，但一樣會被算進「今日偏多觀察名單」。純靜態網站，視覺走 Neo-Brutalist（粗獷主義）風格：
黑色粗邊框、硬陰影、高對比色塊、Archivo Black／Space Grotesk 大字體。資料由 GitHub Actions 每日排程更新。

**免責聲明**：本站訊號僅供個人研究與資訊參考，不構成投資建議。

## 專案結構

```
config/etfs.json        # watchlist（7 檔 ETF，固定）+ sector_watchlist（15 檔產業候選股）
scripts/fetch_data.py    # 每日資料管線：抓大盤 + 兩份清單資料 -> 算指標 -> 算評分 -> 寫 JSON（含 group 標記）
scripts/indicators.py    # SMA / RSI / MACD 純函式
scripts/scoring.py       # 規則式評分邏輯（可追溯每個分數的原因）
site/                    # 靜態網站本體（含 site/data 產出的 JSON），可整包部署
site/indicators.js       # scripts/indicators.py 的 JS 版本，供「手動新增股票」即時計算用
site/scoring.js          # scripts/scoring.py 的 JS 版本，跟 Python 版規則、文字完全一致
.github/workflows/       # 每日排程 workflow
```

`indicators.py`/`scoring.py` 跟 `indicators.js`/`scoring.js` 是同一套規則的兩份實作：
Python 版跑每日排程算追蹤清單，JS 版讓使用者手動新增的股票能在瀏覽器裡即時算出一樣的分數。
兩邊改規則時要一起改，才不會兩種計算方式對不起來。

## 本機測試

```bash
python3 scripts/fetch_data.py   # 重新產生 site/data/market.json、<code>.json、summary.json
python3 -m http.server 8000 --directory site
# 開瀏覽器 http://localhost:8000
```

## 部署步驟（GitHub Pages，免費）

1. 在 GitHub 建一個新 repo，把這個資料夾 push 上去。
   注意：GitHub Pages 的「Deploy from a branch」模式只支援 `/ (root)` 或 `/docs` 資料夾，
   選不到 `/site`，而且 private repo 免費方案不能開 Pages，所以這個專案改用下面的 GitHub Actions 部署法。
2. Repo 設定 -> Pages -> Source 選擇 `GitHub Actions`（不要選 `Deploy from a branch`）。
   `.github/workflows/deploy-pages.yml` 已經寫好，會把 `site/` 資料夾打包部署，每次 push 到 main 都會自動重新部署。
3. Repo 設定 -> Actions -> General -> Workflow permissions，確認允許 `Read and write permissions`
   （daily-update.yml 需要 push 權限才能提交每日資料）。
4.（可選）若之後 FinMind 免費額度不夠用，可到 finmindtrade.com 申請 token，
   在 repo Settings -> Secrets and variables -> Actions 新增 `FINMIND_TOKEN`。
5. 之後每個交易日 10:30、13:30（台北時間）Actions 會自動抓資料、算指標、commit，
   commit 會觸發 `deploy-pages.yml` 自動重新部署網站。也可以到 Actions 頁籤手動點 `Run workflow` 立即跑一次。

## 之後要擴充

- 加減「我的關注清單」固定追蹤的 ETF：改 `config/etfs.json` 的 `watchlist` 陣列。
- 加減「產業觀察清單」候選股票（目前 15 檔半導體/電子 + 金融/高股息）：改 `sector_watchlist` 陣列，
  想改成別的產業主題也是改這裡，不用動程式邏輯；想調整每天顯示幾名，改 `site/app.js` 的 `SECTOR_TOP_N`。
- 使用者自己手動新增/加入關注的股票不需要改設定檔，網站上直接操作即可，存在瀏覽器 localStorage
  （`tw_etf_dashboard_custom_watchlist` 是手動新增的，`tw_etf_dashboard_pinned_sector` 是從產業觀察清單加入關注的）。
- 加入美股/總經資料：在 `scripts/` 下新增對應的 fetch 腳本，輸出到 `site/data/`，
  再到 `site/` 加對應頁面即可，現有結構不需要重構。
- 評分邏輯在 `scripts/scoring.py`（記得同步改 `site/scoring.js`），之後要調整權重或改用機器學習模型，
  換掉 `compute_score`/`computeScore` 的實作即可，資料管線與網站不受影響。
