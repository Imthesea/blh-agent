#!/usr/bin/env bash
# 人机协作的复现回路（Human-in-the-loop）。
# 复制本文件，编辑下方步骤，然后运行。
# agent 运行脚本；用户在自己的终端里按提示操作。
#
# 用法：
#   bash hitl-loop.template.sh
#
# 两个辅助函数：
#   step "<指令>"          → 显示指令，等待按回车
#   capture VAR "<问题>"   → 显示问题，把回答读入 VAR
#
# 最后，采集到的值会以 KEY=VALUE 的形式打印，供 agent 解析。
#
# `capture` 会把值回显到终端（agent 在那里读取它），
# 所以用 capture 采集观察结果，把需要登录的操作留给用户、用 `step`。

set -euo pipefail

step() {
  printf '\n>>> %s\n' "$1"
  read -r -p "    [完成后回车] " _
}

capture() {
  local var="$1" question="$2" answer
  printf '\n>>> %s\n' "$question"
  read -r -p "    > " answer
  printf -v "$var" '%s' "$answer"
}

# --- 在下方编辑 ---------------------------------------------------------

step "打开 http://localhost:3000 的应用并登录。"

capture ERRORED "点击 'Export' 按钮。它报错了吗？(y/n)"

capture ERROR_MSG "粘贴错误信息（没有则填 'none'）："

# --- 在上方编辑 ---------------------------------------------------------

printf '\n--- 采集结果 ---\n'
printf 'ERRORED=%s\n' "$ERRORED"
printf 'ERROR_MSG=%s\n' "$ERROR_MSG"
