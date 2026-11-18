#!/usr/bin/env node
/**
 * 开奖后把「中奖结果」推到企业微信（发给授权人本人）。
 *
 * 触发规则：data/offline.json 里的最新期号，比 data/notify-state.json 记录的
 * 已通知期号更新时才发；同一期重复跑脚本不会重复轰炸。
 *
 * 数据来源：data/offline.json（build-static.mjs 抓下来的快照）
 *           data/predictions.json（本机预测存档，用来算命中战绩）
 *
 * 推送通道（按优先级自动选）：
 *   1) 群机器人 webhook —— data/wecom-config.json 里配了 "webhook" 或环境变量 WECOM_WEBHOOK
 *   2) 企业微信智能机器人单聊 —— wecom-cli 发给授权人本人（需机器人「消息」权限有效）
 *
 * 用法：
 *   node scripts/notify-wecom.mjs                # 有新期号就发
 *   node scripts/notify-wecom.mjs --dry-run      # 只打印消息，不发送、不写状态
 *   node scripts/notify-wecom.mjs --force        # 忽略已通知记录，强制再发一次
 *   node scripts/notify-wecom.mjs --push-status failed   # 在消息里带上推送状态
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT = path.join(ROOT, 'data', 'offline.json');
const PREDICTIONS = path.join(ROOT, 'data', 'predictions.json');
const STATE_FILE = path.join(ROOT, 'data', 'notify-state.json');
const CONFIG_FILE = path.join(ROOT, 'data', 'wecom-config.json');
const SITE = 'https://eartheden.github.io/lottery-ai-predictor/';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
const pushStatusArg = (() => {
  const i = argv.indexOf('--push-status');
  return i >= 0 ? argv[i + 1] : '';
})();

// 与 server.mjs 的 DLT_TIERS 保持一致（超级大乐透现行 7 个奖级）
const DLT_TIERS = {
  '5+2': '一等奖',
  '5+1': '二等奖',
  '5+0': '三等奖',
  '4+2': '三等奖',
  '4+1': '四等奖',
  '4+0': '五等奖',
  '3+2': '五等奖',
  '3+1': '六等奖',
  '2+2': '六等奖',
  '3+0': '七等奖',
  '2+1': '七等奖',
  '1+2': '七等奖',
  '0+2': '七等奖',
};
const TIER_ORDER = ['一等奖', '二等奖', '三等奖', '四等奖', '五等奖', '六等奖', '七等奖'];

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return `${Math.round(n)} 元`;
}

/** UTC ISO → 北京时间 YYYY-MM-DD HH:mm */
function beijing(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (v) => String(v).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

function ballsOf(game) {
  const groups = Array.isArray(game?.groups) ? game.groups : [];
  const front = groups.find((g) => g.key === 'front' || g.label === '前区');
  const back = groups.find((g) => g.key === 'back' || g.label === '后区');
  if (front?.balls?.length && back?.balls?.length) {
    return { front: front.balls.map(Number), back: back.balls.map(Number) };
  }
  // 兜底：解析 "02 09 16 26 35 06 11"
  const nums = String(game?.resultText || '')
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  return nums.length === 7 ? { front: nums.slice(0, 5), back: nums.slice(5) } : { front: [], back: [] };
}

function evaluatePredictions(issue, front, back) {
  const store = readJson(PREDICTIONS);
  const batches = Array.isArray(store?.batches) ? store.batches : [];
  const batch = batches.find((b) => String(b.targetIssue) === String(issue));
  if (!batch || !Array.isArray(batch.results) || !batch.results.length) return null;

  const results = batch.results.map((pick) => {
    const frontHits = (pick.front || []).filter((n) => front.includes(Number(n))).length;
    const backHits = (pick.back || []).filter((n) => back.includes(Number(n))).length;
    const tier = DLT_TIERS[`${frontHits}+${backHits}`] || null;
    return { method: pick.method, frontHits, backHits, tier };
  });

  const wins = results.filter((r) => r.tier);
  const best = wins
    .map((r) => r.tier)
    .sort((a, b) => TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b))[0] || null;
  const maxFront = Math.max(...results.map((r) => r.frontHits));

  return {
    total: results.length,
    winCount: wins.length,
    best,
    maxFront,
    lines: wins.map((r) => `${r.tier}（${r.method} 前${r.frontHits}+后${r.backHits}）`),
  };
}

function buildMessage(snapshot) {
  const game = snapshot?.overview?.game || {};
  const issue = String(game.issue || snapshot?.latestIssue || '');
  const { front, back } = ballsOf(game);
  const pad = (n) => String(n).padStart(2, '0');
  const prizes = Array.isArray(game.prizeLevels) ? game.prizeLevels : [];
  const first = prizes.find((p) => p.name === '一等奖');
  const second = prizes.find((p) => p.name === '二等奖');
  const next = beijing(game?.next?.drawAt || snapshot?.nextDrawAt);

  const lines = [];
  lines.push(`## 大乐透 ${issue} 期开奖结果`);
  lines.push(`**开奖日期**：${game.drawDate || '-'}`);
  lines.push(
    `**开奖号码**：<font color="warning">${front.map(pad).join(' ')}</font>` +
      `　+　<font color="info">${back.map(pad).join(' ')}</font>`,
  );
  lines.push('');
  if (first) {
    lines.push(`**一等奖**：${first.winners} 注 · 单注 ${money(first.amount) || '-'}`);
  }
  if (second) {
    lines.push(`**二等奖**：${second.winners} 注 · 单注 ${money(second.amount) || '-'}`);
  }
  lines.push(`**奖池**：${money(game.pool) || '-'}　**本期销量**：${money(game.sales) || '-'}`);

  const pred = evaluatePredictions(issue, front, back);
  if (pred) {
    lines.push('');
    if (pred.winCount > 0) {
      lines.push(`**本期预测**：${pred.total} 组中 ${pred.winCount} 组中奖，最高 ${pred.best}`);
      lines.push(`> ${pred.lines.join('；')}`);
    } else {
      lines.push(`**本期预测**：${pred.total} 组均未中奖（前区最多命中 ${pred.maxFront} 个）`);
    }
  }

  if (next) {
    lines.push('');
    lines.push(`**下期开奖**：${next}`);
  }
  if (pushStatusArg === 'failed') {
    lines.push('');
    lines.push(`> 注意：本次快照推送 GitHub 失败（网络问题），线上页面可能仍是上一期。`);
  }
  lines.push('');
  lines.push(`[查看完整走势与预测](${SITE})`);
  return { issue, content: lines.join('\n') };
}

/** 授权人 ID 作为 chat_id：优先环境变量 → 本地缓存 → whoami 解析后缓存 */
function resolveChatId() {
  if (process.env.WECOM_CHAT_ID) return process.env.WECOM_CHAT_ID;
  const cached = readJson(CONFIG_FILE)?.chatId;
  if (cached) return cached;

  const raw = execFileSync('wecom-cli', ['identity', 'whoami'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const flat = raw.replace(/\\n/g, '\n');
  const match = flat.match(/授权真人用户身份[\s\S]{0,200}?ID[：:]\s*([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('没能从 whoami 里解析出授权人 ID，可设置 WECOM_CHAT_ID 环境变量指定接收人');
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ chatId: match[1], savedAt: new Date().toISOString() }, null, 2));
  return match[1];
}

function resolveWebhook() {
  return process.env.WECOM_WEBHOOK || readJson(CONFIG_FILE)?.webhook || null;
}

/** 群机器人 webhook 通道：最省心，不需要机器人消息权限 */
async function sendByWebhook(webhook, content) {
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => ({}));
  if (data?.errcode !== 0) {
    throw new Error(`webhook 返回 errcode=${data?.errcode ?? '?'} ${data?.errmsg || ''}`.trim());
  }
  return 'webhook';
}

/** 智能机器人单聊通道：需要机器人「消息」使用权限未过期 */
function sendByAibot(chatId, content) {
  const payload = JSON.stringify({ chat_id: chatId, msg_type: 'markdown', markdown: { content } });
  try {
    execFileSync('wecom-cli', ['message', 'aibot', 'send', '--json', payload], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    // CLI 把业务错误放在 stdout 的 JSON 里，这里摘出来，别把整条命令原样甩进日志
    const stdout = String(error.stdout || '');
    try {
      const parsed = JSON.parse(stdout);
      if (parsed?.errcode) {
        const hint = parsed.errcode === 850003 ? '（机器人「消息」权限已过期，需机器人创建者在小程序里重新授权）' : '';
        throw new Error(`errcode=${parsed.errcode} ${parsed.errmsg || ''}${hint}`);
      }
    } catch (parseError) {
      if (parseError instanceof Error && parseError.message.startsWith('errcode=')) throw parseError;
    }
    throw new Error(error.message.split('\n')[0]);
  }
  return 'aibot';
}

async function main() {
  const snapshot = readJson(SNAPSHOT);
  if (!snapshot) throw new Error('没有 data/offline.json，先跑一次 scripts/build-static.mjs');

  const { issue, content } = buildMessage(snapshot);
  if (!issue) throw new Error('快照里没有期号');

  const state = readJson(STATE_FILE) || {};
  if (!FORCE && String(state.lastIssue) === issue) {
    console.log(`期号 ${issue} 已通知过，跳过企业微信推送`);
    return;
  }

  if (DRY_RUN) {
    console.log('—— 预演，不发送 ——');
    console.log(content);
    return;
  }

  const webhook = resolveWebhook();
  const channel = webhook ? await sendByWebhook(webhook, content) : sendByAibot(resolveChatId(), content);
  console.log(`已推送企业微信（${channel}）：${issue} 期`);

  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ lastIssue: issue, notifiedAt: new Date().toISOString(), channel }, null, 2),
  );
}

main().catch((error) => {
  console.error(`企业微信通知失败：${error.message}`);
  process.exit(1);
});
