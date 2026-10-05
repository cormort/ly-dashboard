#!/data/data/com.termux/files/usr/bin/bash
# 在專案資料夾開 Antigravity CLI（curl -fsSL https://antigravity.google/cli/install.sh | bash 安裝的那支）。
# 安裝程式放的位置不一定在捷徑的 PATH 裡，所以先補上常見的安裝位置；指令名稱 agy／antigravity 都試。
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.antigravity/bin:$HOME/.antigravity/cli/bin:$PATH"

for cmd in agy antigravity; do
  command -v "$cmd" >/dev/null && exec "$cmd" "$@"
done

echo "找不到 Antigravity CLI（agy／antigravity）。"
echo "請在 Termux 執行：curl -fsSL https://antigravity.google/cli/install.sh | bash"
echo "裝好後若還是找不到，執行 ls ~/.local/bin ~/.antigravity 看裝在哪裡，告訴我路徑。"
echo
echo "按 Enter 關閉"
read -r
