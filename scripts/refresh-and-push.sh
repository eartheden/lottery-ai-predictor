#!/bin/bash
# 每天刷新开奖快照并推送到 GitHub，Pages 收到 push 后自动重新发布。
# 体彩官网只在开奖后才有新数据，没新期号时不会产生空提交。
set -e
cd "$(dirname "$0")/.."

echo "== 抓取最新开奖"
node scripts/build-static.mjs

echo "== 提交快照"
git add data/offline.json
if git diff --cached --quiet; then
  echo "开奖数据没有变化，跳过提交"
  exit 0
fi
git -c user.name="eartheden" -c user.email="eartheden@users.noreply.github.com" \
  commit -q -m "data: 刷新开奖快照 $(date +%F)"
git push -q origin main
echo "== 已推送，等待 GitHub Pages 自动发布"
