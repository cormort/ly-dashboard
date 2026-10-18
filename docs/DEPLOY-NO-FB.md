# 部署（不抓 FB 粉專）

> 這份回答「不要每日粉專抓取，只把其他資料自動化，搬到一台 Linux 主機」怎麼做。
> 它是 `docs/DEPLOY-VM.md` 的精簡路線（相當於拓撲 B 拿掉 Mac Mini 那一半），細節與 VM 才有的坑以那份為準。

---

## 0. 拿掉 FB 之後，會變成什麼樣

| 項目 | 拿掉之後 |
| --- | --- |
| 名錄／議事／預算／法規 | 伺服器內建排程，每 24 小時一輪，**全自動** |
| 媒體 RSS／Google 新聞 | 伺服器每 1 小時／6 小時，**全自動** |
| 委員粉專牆的嵌入框 | **照常**（Facebook 官方 Page Plugin，在瀏覽器端即時載入，不靠抓取） |
| 粉專帳號清單 | 照常（每輪同步讀 Google 整理表） |
| 「最新貼文」日期／摘要／讚數、臉書排行榜 | 資料會停在最後一次抓取 → 設 `LY_FB_SCRAPE=0`（§4）**收掉不顯示** |
| 「整理表過期」提示 | 同上，設了就不會出現 |

不需要的東西：Chrome、`~/.ly-dashboard/fb-profile/`、`sheet.env`、`notify.env`（Telegram 只有粉專抓取在用）、
`apps-script/`。

---

## 1. 準備主機

規格與網路要求見 `docs/DEPLOY-VM.md` §2（2 vCPU、2 GB、20 GB、`Asia/Taipei`）。不必裝 Chrome。

```bash
sudo apt update && sudo apt install -y git curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs
node -e 'require("node:sqlite"); console.log("node:sqlite OK")'
sudo timedatectl set-timezone Asia/Taipei
```

## 2. 放程式、建前端

```bash
sudo mkdir -p /opt && sudo git clone https://github.com/cormort/ly-dashboard.git /opt/ly-dashboard
sudo chown -R "$USER":"$USER" /opt/ly-dashboard
cd /opt/ly-dashboard
npm ci && npm --prefix web ci && npm --prefix web run build
```

## 3. 第一次抓資料

```bash
node server/ingest.mjs          # 8–15 分鐘；社群資料會從整理表與 fb-data 分支讀進最後一版
```

## 4. 交給 systemd（**不要**加 `--with-fb`）

```bash
bash deploy/linux/install.sh --dry-run
sudo bash deploy/linux/install.sh
systemctl status ly-dashboard-server --no-pager
```

這樣只裝 API 伺服器，不會有 `ly-dashboard-fb-daily.timer`。

再告訴伺服器「這台不抓粉專」（D288）：

```bash
mkdir -p ~/.ly-dashboard && chmod 700 ~/.ly-dashboard
echo 'LY_FB_SCRAPE=0' >> ~/.ly-dashboard/server.env
sudo systemctl restart ly-dashboard-server
curl -s 'http://127.0.0.1:8787/api/v1/rankings?type=all' | jq '.boards | keys'   # 不該有 "facebook"
```

## 5. 驗收（第一天一定要跑 `--live`）

```bash
bash deploy/linux/verify-vm.sh --live          # 實打立法院／g0v／法務部／RSS 各一次
curl -s http://127.0.0.1:8787/api/v1/health | jq '{ok, fetched: .meta.fetched_at, warnings: .warnings}'
```

`--live` 不通 → 多半是機房 IP 被來源擋，處置見 `docs/DEPLOY-VM.md` §4 第 1 點。

## 6. 對外

照 `docs/DEPLOY-VM.md` §3 Step 5：Tailscale（建議）或 Caddy ＋ HTTPS ＋帳密。

## 7. 每月人口更新（原本靠 Hermes cron，主機上要自己排）

`scripts/refresh-county-stats.sh` 會改 `server/*.json`，跑完要重啟伺服器才生效。用 crontab 排在每月 12 日：

```bash
crontab -e
# 每月 12 日 09:30（主機時區 Asia/Taipei）
30 9 12 * * cd /opt/ly-dashboard && scripts/refresh-county-stats.sh >> .cache/county.log 2>&1 && sudo systemctl restart ly-dashboard-server
```

- `sudo systemctl restart` 在 crontab 裡要免密碼：`sudo visudo` 加一行
  `<你的帳號> ALL=(root) NOPASSWD: /usr/bin/systemctl restart ly-dashboard-server`。
- 腳本體檢不過會非 0 離開，`&&` 就不會重啟，舊資料保留。
- 這些檔案改在主機的工作目錄、沒有 commit；之後 `git pull` 若衝突，先 `git checkout -- server/*.json` 再拉，
  然後重跑一次這支腳本。

## 8. 仍然需要人的事

| 什麼時候 | 做什麼 |
| --- | --- |
| 部署後第一週 | 每天看一次 `/api/v1/health` 的 `warnings` 與 `journalctl -u ly-dashboard-server` |
| 每季 | `npm audit`、確認 HTTPS 憑證沒過期 |
| 換屆（第 12 屆） | 手動同步一次並逐頁檢查（真實換屆還沒跑過，見 `docs/OPS.md` §5） |
| 更新程式 | `docs/DEPLOY-VM.md` §6 |
