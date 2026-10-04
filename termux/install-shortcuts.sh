#!/data/data/com.termux/files/usr/bin/bash
# 在 ~/.shortcuts 建立 Termux:Widget 桌面捷徑。只需執行一次：bash termux/install-shortcuts.sh
# 捷徑本身只轉呼叫專案裡的腳本，之後 git pull 更新腳本，捷徑不用重裝。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${SHORTCUTS_DIR:-$HOME/.shortcuts}"
mkdir -p "$DIR"

make() { # 名稱 腳本
  printf '#!/data/data/com.termux/files/usr/bin/bash\nexec bash "%s/termux/%s"\n' "$ROOT" "$2" > "$DIR/$1"
  chmod +x "$DIR/$1"
  echo "已建立：$DIR/$1"
}

make "立委觀測站" launch.sh
make "更新立委觀測站" update.sh
make "回補新聞" backfill.sh

echo "完成。到桌面長按 → 小工具 → Termux:Widget，把捷徑拖到桌面。"
