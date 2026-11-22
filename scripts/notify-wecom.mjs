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
 * 推送通道（按优先级自动选，配了哪个用哪个）：
 *   1) Server酱  —— data/wecom-config.json 的 "serverChanSendKey" 或环境变量 SERVERCHAN_SENDKEY（直达个人微信）
 *   2) PushPlus  —— "pushplusToken" 或 PUSHPLUS_TOKEN（直达个人微信）
 *   3) 企业微信群机器人 —— "webhook" 或 WECOM_WEBHOOK
 *   4) 企业微信智能机器人单聊 —— wecom-cli，发给授权人本人（需机器人「消息」权限有效）
 *
 * 用法：
 *   node scripts/notify-wecom.mjs                # 有新期号就发开奖结果
 *   node scripts/notify-wecom.mjs --prediction   # 发送最新一批下期预测号码（生成后自动触发）
 *   node scripts/notify-wecom.mjs --batch-id <id># 指定预测批次（配合 --prediction）
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
const PREDICTION_MODE = argv.includes('--prediction');
const batchIdArg = (() => {
  const i = argv.indexOf('--batch-id');
  if (i < 0) return '';
  const value = argv[i + 1];
  return value && !value.startsWith('--') ? value : '';
})();
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
const METHOD_LABELS = {
  ai: 'AI 多维集成',
  cosmos: '宇宙通识常量',
  chaos: '混沌动力学',
  markov: '马尔可夫链',
  birthday: '生日 + 今日时间',
  random: '随机灵感',
  history: '历史热度（已下线）',
  omission: '遗漏回补（已下线）',
};

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

  // 企业微信支持 <font color> 上色，微信侧（Server酱/PushPlus）走纯 Markdown，用加粗代替
  const render = (color) => {
    const ball = (nums, tone) =>
      color ? `<font color="${tone}">${nums}</font>` : `**${nums}**`;
    const lines = [];
    lines.push(`**开奖日期**：${game.drawDate || '-'}`);
    lines.push(
      `**开奖号码**：${ball(front.map(pad).join(' '), 'warning')}` +
        `　+　${ball(back.map(pad).join(' '), 'info')}`,
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
    return lines.join('\n');
  };

  const title = `大乐透 ${issue} 期开奖结果`;
  return {
    issue,
    title,
    aibotContent: `## ${title}\n${render(true)}`,
    wxContent: render(false),
  };
}

/** 下期预测生成后推送：把整批号码发到微信 */
function buildPredictionMessage(batch) {
  const issue = String(batch?.targetIssue || '');
  const pad = (n) => String(n).padStart(2, '0');
  const methods = Array.isArray(batch?.methods) && batch.methods.length
    ? batch.methods.map((m) => METHOD_LABELS[m] || m).join(' / ')
    : '—';
  const created = beijing(batch?.createdAt);
  const next = beijing(batch?.targetDrawAt);

  const render = (color) => {
    const ball = (nums, tone) => (color ? `<font color="${tone}">${nums}</font>` : `**${nums}**`);
    const lines = [];
    lines.push(`**目标期号**：${issue}`);
    lines.push(`**基于期号**：${batch?.baseIssue || '-'}`);
    lines.push(`**生成时间**：${created || '-'}`);
    if (next) lines.push(`**开奖时间**：${next}`);
    lines.push(`**生成策略**：${methods}`);
    lines.push('');
    const results = Array.isArray(batch?.results) ? batch.results : [];
    results.forEach((pick, i) => {
      const front = (pick.front || []).map(Number).map(pad).join(' ');
      const back = (pick.back || []).map(Number).map(pad).join(' ');
      const label = METHOD_LABELS[pick.method] || pick.method || '—';
      lines.push(`${i + 1}. ${ball(front, 'warning')} + ${ball(back, 'info')}　\`${label}\``);
    });
    lines.push('');
    lines.push('> 开奖为独立随机事件，号码仅供娱乐参考');
    lines.push('');
    lines.push(`[查看完整走势与预测](${SITE})`);
    return lines.join('\n');
  };

  const title = `大乐透 ${issue} 期下期预测`;
  return {
    issue,
    title,
    aibotContent: `## ${title}\n${render(true)}`,
    wxContent: render(false),
  };
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
  // 必须合并写回，否则会把已配好的 SendKey / PushPlus / webhook 全部抹掉
  const config = readJson(CONFIG_FILE) || {};
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ ...config, chatId: match[1], savedAt: new Date().toISOString() }, null, 2),
  );
  return match[1];
}

function resolveWebhook() {
  return process.env.WECOM_WEBHOOK || readJson(CONFIG_FILE)?.webhook || null;
}

/** Server酱：https://sct.ftqq.com 扫码后拿 SendKey，消息以公众号服务通知进微信 */
async function sendByServerChan(sendKey, title, content) {
  const key = /^sct/i.test(sendKey) ? sendKey : `SCT${sendKey}`;
  const response = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, desp: content }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => ({}));
  if (data?.code !== 0) throw new Error(`Server酱返回 code=${data?.code ?? '?'} ${data?.message || ''}`.trim());
  return 'serverchan';
}

/** PushPlus：https://www.pushplus.plus 扫码后拿 token，同样是公众号推送到微信 */
async function sendByPushPlus(token, title, content) {
  const response = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, title, content, template: 'markdown' }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => ({}));
  if (data?.code !== 200) throw new Error(`PushPlus返回 code=${data?.code ?? '?'} ${data?.msg || ''}`.trim());
  return 'pushplus';
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
    // execFileSync 的第一行含完整命令行（里面有 chat_id），只输出固定类别文案
    throw new Error('wecom-cli 单聊发送失败（详见 wecom-cli 自身输出）');
  }
  return 'aibot';
}

async function main() {
  const state = readJson(STATE_FILE) || {};
  let message;
  let dedupeKey;
  let dedupeValue;

  if (PREDICTION_MODE) {
    if (argv.includes('--batch-id') && !batchIdArg) throw new Error('--batch-id 缺少参数值');
    const store = readJson(PREDICTIONS);
    const batches = Array.isArray(store?.batches) ? store.batches : [];
    const batch = batchIdArg
      ? batches.find((b) => String(b.id) === batchIdArg)
      : batches.find((b) => b.status === 'pending');
    if (!batch) throw new Error(batchIdArg ? `找不到预测批次 ${batchIdArg}` : '没有待开奖的预测批次');
    message = buildPredictionMessage(batch);
    dedupeKey = 'lastPredictionBatchId';
    dedupeValue = String(batch.id);
  } else {
    const snapshot = readJson(SNAPSHOT);
    if (!snapshot) throw new Error('没有 data/offline.json，先跑一次 scripts/build-static.mjs');
    message = buildMessage(snapshot);
    dedupeKey = 'lastIssue';
    dedupeValue = String(message.issue);
  }

  const { issue, title, aibotContent, wxContent } = message;
  if (!issue) throw new Error('没有期号');

  if (!FORCE && String(state[dedupeKey]) === String(dedupeValue)) {
    console.log(`${PREDICTION_MODE ? '预测批次' : '期号'} ${dedupeValue} 已通知过，跳过推送`);
    return;
  }

  const config = readJson(CONFIG_FILE) || {};
  const serverChanKey = process.env.SERVERCHAN_SENDKEY || config.serverChanSendKey;
  const pushplusToken = process.env.PUSHPLUS_TOKEN || config.pushplusToken;

  if (DRY_RUN) {
    const channel = serverChanKey ? 'Server酱' : pushplusToken ? 'PushPlus' : resolveWebhook() ? '群机器人' : '企业微信单聊';
    console.log(`—— 预演，不发送（当前通道：${channel}）——`);
    console.log(`【标题】${title}`);
    console.log(wxContent);
    return;
  }

  // 通道优先级：Server酱 → PushPlus → 企业微信群机器人 → 智能机器人单聊。
  // 主通道配了但失败时继续降级，不能因为一个通道抖动就整条通知丢失。
  const webhook = resolveWebhook();
  const candidates = [];
  if (serverChanKey) candidates.push(['serverchan', () => sendByServerChan(serverChanKey, title, wxContent)]);
  if (pushplusToken) candidates.push(['pushplus', () => sendByPushPlus(pushplusToken, title, wxContent)]);
  if (webhook) candidates.push(['webhook', () => sendByWebhook(webhook, wxContent)]);
  candidates.push(['aibot', () => sendByAibot(resolveChatId(), aibotContent)]);

  let channel = null;
  const failures = [];
  for (const [name, send] of candidates) {
    try {
      channel = await send();
      break;
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      console.warn(`通道 ${name} 发送失败，尝试下一个：${error.message}`);
    }
  }
  if (!channel) throw new Error(`所有通知通道均失败：${failures.join(' | ')}`);
  console.log(`已推送（${channel}）：${issue} 期${PREDICTION_MODE ? '预测' : '开奖结果'}`);

  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  // 写前重新读取，避免与另一路通知（开奖 / 预测）并发时把对方的去重键覆盖回旧值；
  // 临时文件 + rename 保证不会写出半截 JSON。
  const latestState = readJson(STATE_FILE) || state;
  const nextState = {
    ...latestState,
    [dedupeKey]: dedupeValue,
    notifiedAt: new Date().toISOString(),
    channel,
  };
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(nextState, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

main().catch((error) => {
  console.error(`通知发送失败：${error.message}`);
  process.exit(1);
});
