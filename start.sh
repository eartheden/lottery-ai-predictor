#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "正在启动大乐透数据中心…"
echo "访问地址：http://127.0.0.1:8787"
node server.mjs
