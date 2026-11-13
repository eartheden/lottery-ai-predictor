#!/bin/bash
# 大乐透数据中心 · 本地服务一键启动
# 双击即可：若服务未运行则启动，并自动打开浏览器
cd "$(dirname "$0")" || exit 1

PORT=8787
URL="http://127.0.0.1:$PORT/"

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "服务已在运行：$URL"
else
  echo "正在启动大乐透数据中心 ..."
  nohup node server.mjs >/tmp/dlt-8787.log 2>&1 &
  sleep 2
  if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "启动成功：$URL"
  else
    echo "启动失败，请查看 /tmp/dlt-8787.log"
    read -r -p "按回车键关闭窗口..." _
    exit 1
  fi
fi

open "$URL"
echo ""
echo "服务地址：$URL"
echo "（关闭本窗口不会停止服务；如需停止：lsof -ti:8787 | xargs kill）"
sleep 2
