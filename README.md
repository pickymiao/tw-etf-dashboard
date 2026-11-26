# 市場觀測（公開端）

每個交易日 18:30（台北時間）由 GitHub Actions 自動抓資料，輸出 `site/data/market.json`，並部署成 GitHub Pages。

**這個 repo 只放市場資料，不放任何個人持股、成本或金額。** 個人資料放在私人 Google Sheet，由 Apps Script 私人頁面讀取本 repo 的 `market.json` 後合併計算。

## 內容

| 項目 | 說明 |
|---|---|
| 持股 6 檔 | 009816、00981A、00400A（成長類）／00878、00900、00940（高股息類），價格已還原除息 |
| 全球指標 | 費半、NASDAQ、S&P 500、VIX、美債 10Y、美元／台幣（Yahoo Finance）；對齊台股前一交易日 |
| 市場廣度 | 15 檔權值股站上 20 日均線的比例 |
| 市場狀態 | 規則式判斷：正常／注意／警戒／大跌／回穩，附觸發原因 |
| 相關性 | 各持股與台股加權、前一日費半的 60 日報酬相關係數 |

## 檔案

```
config/etfs.json          持股、廣度樣本、全球指標、狀態門檻
scripts/fetch_data.py     每日資料管線
scripts/market_state.py   市場狀態規則
scripts/indicators.py     均線等工具函式
site/index.html           公開頁（只有市場資訊）
site/render.js            畫面元件（私人頁共用）
site/style.css            畫面樣式
```

## 調整

- 增減持股：改 `config/etfs.json` 的 `holdings`（`category` 填 `growth` 或 `dividend`）
- 調整狀態門檻：改 `config/etfs.json` 的 `rules`

本機測試：`python3 scripts/fetch_data.py && python3 -m http.server 8000 --directory site`

市場狀態由固定規則自動判斷，僅供參考，不構成投資建議。
