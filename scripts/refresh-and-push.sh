#!/bin/bash
# 每天刷新开奖快照并推送到 GitHub，Pages 收到 push 后自动重新发布。
# 体彩官网只在开奖后才有新数据，没新期号时不会产生空提交。
# 抓完之后若有新期号，顺带把开奖结果推送到企业微信（scripts/notify-wecom.mjs）。
set -e
cd "$(dirname "$0")/.."

echo "== 抓取最新开奖"
node scripts/build-static.mjs

PUSH_STATUS="none"
echo "== 提交快照"
git add data/offline.json
if git diff --cached --quiet; then
  echo "开奖数据没有变化，跳过提交"
else
  git -c user.name="eartheden" -c user.email="eartheden@users.noreply.github.com" \
    commit -q -m "data: 刷新开奖快照 $(date +%F)"
  echo "== 推送"
  # 推送失败不终止流程：企业微信照样把开奖结果发出去，本地提交留着下次补推
  if git push -q origin main; then
    PUSH_STATUS="ok"
    echo "== 已推送，等待 GitHub Pages 自动发布"
  else
    PUSH_STATUS="failed"
    echo "！推送失败（多为网络问题），提交已保存在本地，下次运行会自动补推"
  fi
fi

echo "== 企业微信通知"
NOTIFY_STATUS="skipped"
if [ "${SKIP_NOTIFY:-0}" = "1" ]; then
  echo "SKIP_NOTIFY=1，跳过企业微信通知"
else
  # 通知失败不中断抓取/推送成果，但用独立退出码 2 暴露出来，避免默默漏通知
  if node scripts/notify-wecom.mjs --push-status "$PUSH_STATUS"; then
    NOTIFY_STATUS="ok"
  else
    NOTIFY_STATUS="failed"
    echo "！企业微信通知失败，详见上方日志"
  fi
fi

if [ "$PUSH_STATUS" = "failed" ]; then
  exit 1
fi
if [ "$NOTIFY_STATUS" = "failed" ]; then
  exit 2
fi
