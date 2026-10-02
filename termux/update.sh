#!/data/data/com.termux/files/usr/bin/bash
# 從 GitHub 更新程式碼後啟動。git pull 失敗（Token 過期、本機檔案衝突）會停住讓你看訊息。
cd "$(dirname "$0")/.." || exit 1

git pull || { echo "git pull 失敗，按 Enter 關閉"; read -r; exit 1; }
# git pull 可能更新了這個資料夾的腳本，所以用 exec 換成新版再往下走
exec bash termux/launch.sh
