# fb-data

立委粉專每日抓取結果（由 Mac Mini 的 launchd 每天 08:00 推上來），程式在 main 的 `scripts/push-fb-data.mjs`。

- `posts/YYYY-MM-DD.csv`：當天抓取的整理表格式 CSV（編號,姓名,政黨,選區,粉專名稱,最新貼文日期,最新貼文主題摘要,貼文或粉專連結,Threads…）
- `posts/latest.csv`：同一份內容，讀最新的抓這一個檔就好

寫入規則（見 main 的 `docs/fb-daily-update.md`）：抓不到就留空、不填今天；只更新本來就有對應編號的列。
這份資料同時會由 Apps Script Web App 寫回 Google 整理表；這裡放一份是為了「遠端讀得到＋備份」。
