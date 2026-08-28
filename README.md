# 訓練紀錄

個人用的重訓與飲食紀錄 PWA。純前端、無建置流程，資料存在 Supabase（雲端 Postgres），本機用 localStorage 做離線快取。

## 設計重點

- **輸入要快**：點動作即自動帶入上次的重量、次數、RPE，只改要改的地方。「＋ 再一組」複製上一組。
- **動作依部位分類**：新增動作時要選推／拉／腿／核心／其他，記錄頁與動作庫都能用分類篩選。
- **離線可用**：Service Worker 快取整個 App 殼；資料寫入先落地本機再背景同步，健身房沒訊號一樣能記錄，恢復連線後自動補上傳（見下方「離線同步」）。
- **每個動作都能看趨勢**：動作庫可切換重量／次數／估算 1RM 三種指標畫進步曲線，並列出可編輯、可刪除的完整歷史。
- **雲端跨裝置**：登入後手機、電腦看到同一份資料，靠 Supabase Auth + Row Level Security 保護。

## 建立 Supabase 專案

1. 到 [supabase.com](https://supabase.com) 註冊/登入，New Project 建立一個新專案（記得存好資料庫密碼）。
2. 左側 **SQL Editor** → New query → 貼上 [supabase/schema.sql](supabase/schema.sql) 全部內容 → Run。這會建立 5 張表（exercises／sets／body_metrics／food_logs／pinned_exercises）並開啟 Row Level Security，確保每個帳號只能讀寫自己的資料。
3. 左側 **Project Settings → API** → 複製 **Project URL** 和 **anon public key**。
4. 打開 [supabaseClient.js](supabaseClient.js)，把 `SUPABASE_URL` 和 `SUPABASE_ANON_KEY` 換成剛複製的值。
5.（可選）**Authentication → Providers → Email** → 個人使用可關掉「Confirm email」，註冊完不用收信驗證就能直接登入。

anon key 是公開金鑰，本來就是設計給前端用的，安全性由 Row Level Security 規則負責，不是靠隱藏這把 key。

## 離線同步

寫入（記錄一組、改體重…）一律先更新畫面上看到的本機狀態，再嘗試背景同步到 Supabase；連不上網路時會排進本機的待同步佇列，重新連線或下次開 App 時自動補送。頂部日期列右邊的小圓點顯示同步狀態：綠色＝已同步、黃色＝有資料待同步、紅色＝目前離線。

## 頁面

| 分頁 | 內容 |
|---|---|
| 記錄 | 動作搜尋（新增動作要選部位）、今日紀錄、依分類篩選的最近做過、飲食、體重／體脂率／骨骼肌重 |
| 週 | 七天格子、訓練天數／總量／對比上週、本週動作彙總 |
| 動作 | 身體數據趨勢（體重／體脂率／骨骼肌重）、動作庫（依部位篩選）；點進單一動作看重量／次數／估算1RM 趨勢圖與完整歷史，可編輯、刪除每一筆 |
| 設定 | 帳號登出、匯出／匯入 JSON、資料統計、清除資料 |

估算 1RM 用 Epley 公式 `1RM ≈ 重量 × (1 + 次數 / 30)`，讓不同重量與次數的組能放在同一個尺度上比較。次數超過約 12 下會高估，當趨勢看即可。

## 檔案

```
index.html          頁面結構
styles.css           樣式
app.js                主要邏輯（ES module）
supabaseClient.js     Supabase 連線設定
sw.js                 離線快取（App 殼）
manifest.json         PWA 設定
icon-*.png            圖示
supabase/schema.sql   資料庫 schema（表格 + RLS）
```

## 部署

純靜態檔案，丟到 GitHub Pages 就能跑，不需要建置流程或伺服器。

## 備份

雖然資料主要存在雲端，設定頁仍可「匯出 JSON」多留一份保險備份；「匯入 JSON」會整組覆蓋目前帳號裡的資料，請謹慎使用。
