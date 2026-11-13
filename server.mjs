import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'overview-cache.json');
const PRED_FILE = path.join(DATA_DIR, 'predictions.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'user-settings.json');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const UPSTREAM = 'https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry';
const SOURCE_NAME = '中国体彩网';
const REFRESH_MS = 30_000;
const MAX_BATCHES = 60;
const MAX_PICKS = 20;

// 超级大乐透现行 7 个奖级（2026 年规则），与前端 DLT_TIERS 保持一致
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
// 新生成只接受这六种策略；history / omission 已下线（历史批次仍按原样存档回显）
const METHOD_KEYS = new Set(['birthday', 'random', 'ai', 'cosmos', 'chaos', 'markov']);

const GAME = {
  no: '85',
  key: 'dlt',
  name: '超级大乐透',
  short: '大乐透',
  glyph: '大',
  type: '数字型',
  format: 'dlt',
  accent: '#ff5a4d',
  rule: '前区 5 个号码（01-35）+ 后区 2 个号码（01-12）',
  schedule: {
    days: [1, 3, 6],
    saleEnd: [21, 0],
    draw: [21, 25],
    label: '每周一、三、六 21:00 停售',
  },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const memoryCache = new Map();
let overviewCache = null;
let diskCachePromise = null;

function getMemory(key) {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return hit.data;
}

function setMemory(key, data, ttlMs) {
  memoryCache.set(key, { data, expires: Date.now() + ttlMs });
  if (memoryCache.size > 120) {
    memoryCache.delete(memoryCache.keys().next().value);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'object') return null;
  const n = Number(String(value).replace(/[,，%＋+]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function nextDraw(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 3600 * 1000);
  const y = shifted.getUTCFullYear();
  const mo = shifted.getUTCMonth();
  const d = shifted.getUTCDate();

  for (let offset = 0; offset < 10; offset += 1) {
    const day = new Date(Date.UTC(y, mo, d + offset));
    const weekday = day.getUTCDay() || 7;
    if (!GAME.schedule.days.includes(weekday)) continue;
    const saleAt = Date.UTC(y, mo, d + offset, GAME.schedule.saleEnd[0] - 8, GAME.schedule.saleEnd[1], 0);
    const drawAt = Date.UTC(y, mo, d + offset, GAME.schedule.draw[0] - 8, GAME.schedule.draw[1], 0);
    if (saleAt > now.getTime()) {
      return {
        saleAt: new Date(saleAt).toISOString(),
        drawAt: new Date(drawAt).toISOString(),
        label: GAME.schedule.label,
      };
    }
  }
  return null;
}

function normalizeDraw(raw, { summary = false } = {}) {
  const tokens = String(raw?.lotteryDrawResult || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const prizeLevels = (raw?.prizeLevelList || [])
    .map((prize) => ({
      name: prize.prizeLevel || '—',
      winners: toNumber(prize.stakeCount),
      amount: toNumber(prize.stakeAmount),
      total: toNumber(prize.totalPrizeamount),
    }))
    .filter((prize) => prize.name !== '—');

  return {
    gameNo: GAME.no,
    gameKey: GAME.key,
    gameName: GAME.name,
    glyph: GAME.glyph,
    accent: GAME.accent,
    type: GAME.type,
    format: GAME.format,
    issue: String(raw?.lotteryDrawNum || ''),
    drawDate: raw?.lotteryDrawTime || '',
    saleEnd: raw?.lotterySaleEndtime || '',
    resultText: tokens.join(' '),
    groups: [
      { key: 'front', label: '前区', tone: 'red', balls: tokens.slice(0, 5) },
      { key: 'back', label: '后区', tone: 'blue', balls: tokens.slice(5, 7) },
    ],
    sales: toNumber(raw?.totalSaleAmount),
    pool: toNumber(raw?.poolBalanceAfterdraw) ?? toNumber(raw?.poolBalance) ?? 0,
    prizeLevels: summary ? [] : prizeLevels,
    rule: GAME.rule,
  };
}

async function fetchPage(page, pageSize) {
  const params = new URLSearchParams({
    gameNo: GAME.no,
    provinceId: '0',
    pageSize: String(pageSize),
    isVerify: '1',
    pageNo: String(page),
  });
  const url = `${UPSTREAM}?${params.toString()}`;
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Referer: 'https://www.lottery.gov.cn/',
          Accept: 'application/json, text/plain, */*',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`上游接口 HTTP ${response.status}`);
      const json = await response.json();
      if (json?.success === false) throw new Error(json?.errorMessage || '上游接口返回失败');
      if (!json?.value) throw new Error('上游接口返回空数据');
      return json.value;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(350 * (attempt + 1));
    }
  }
  throw lastError || new Error('上游接口请求失败');
}

async function getLatest() {
  const key = 'latest:dlt';
  const cached = getMemory(key);
  if (cached) return cached;

  const value = await fetchPage(1, 1);
  const raw = (value.list && value.list[0]) || value.lastPoolDraw;
  if (!raw || !raw.lotteryDrawNum) throw new Error('暂无大乐透开奖数据');

  const draw = normalizeDraw(raw);
  draw.next = nextDraw();
  setMemory(key, draw, REFRESH_MS);
  return draw;
}

async function readDiskCache() {
  if (!diskCachePromise) {
    diskCachePromise = fs
      .readFile(CACHE_FILE, 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => null);
  }
  return diskCachePromise;
}

async function buildOverview() {
  try {
    const game = await getLatest();
    const data = {
      success: true,
      source: SOURCE_NAME,
      updatedAt: new Date().toISOString(),
      refreshMs: REFRESH_MS,
      stale: false,
      game,
    };
    await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
    await fs.writeFile(CACHE_FILE, JSON.stringify(data), 'utf8').catch(() => {});
    diskCachePromise = Promise.resolve(data);
    return data;
  } catch (error) {
    const disk = await readDiskCache();
    if (disk?.game?.issue) {
      return {
        success: true,
        source: SOURCE_NAME,
        updatedAt: disk.updatedAt || new Date().toISOString(),
        refreshMs: REFRESH_MS,
        stale: true,
        game: { ...disk.game, stale: true },
        warning: error.message,
      };
    }
    throw error;
  }
}

async function getOverview(force = false) {
  if (!force && overviewCache && Date.now() - overviewCache.at < REFRESH_MS) {
    return { ...overviewCache.data, cached: true };
  }
  const data = await buildOverview();
  overviewCache = { at: Date.now(), data };
  return data;
}

async function getHistoryPage(page, pageSize) {
  const key = `page:${pageSize}:${page}`;
  const cached = getMemory(key);
  if (cached) return cached;
  const value = await fetchPage(page, pageSize);
  setMemory(key, value, 60_000);
  return value;
}

async function getHistory(page, pageSize) {
  const value = await getHistoryPage(page, pageSize);
  return {
    success: true,
    gameNo: GAME.no,
    page,
    pageSize,
    total: toNumber(value.total) || 0,
    pages: toNumber(value.pages) || 0,
    draws: (value.list || []).map((raw) => normalizeDraw(raw, { summary: true })),
  };
}

async function findIssue(issue) {
  const key = `issue:${issue}`;
  const cached = getMemory(key);
  if (cached) return cached;

  const firstPage = await getHistoryPage(1, 100);
  const total = toNumber(firstPage.total) || 0;
  const pages = toNumber(firstPage.pages) || Math.max(1, Math.ceil(total / 100));
  const target = Number(issue);
  if (!Number.isFinite(target)) return null;

  let lo = 1;
  let hi = pages;
  let found = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const page = mid === 1 ? firstPage : await getHistoryPage(mid, 100);
    const list = page.list || [];
    if (list.length === 0) break;

    const first = Number(list[0].lotteryDrawNum);
    const last = Number(list[list.length - 1].lotteryDrawNum);

    if (target > first) {
      hi = mid - 1;
    } else if (target < last) {
      lo = mid + 1;
    } else {
      found = list.find((item) => String(item.lotteryDrawNum) === String(issue)) || null;
      break;
    }
  }

  if (found) setMemory(key, found, 300_000);
  return found;
}

function buildAnalysis(value, limit) {
  const draws = (value.list || []).map((raw) => normalizeDraw(raw, { summary: true }));
  const frontFreqMap = new Map();
  const backFreqMap = new Map();
  for (let n = 1; n <= 35; n += 1) frontFreqMap.set(n, 0);
  for (let n = 1; n <= 12; n += 1) backFreqMap.set(n, 0);

  const frontOmissionMap = new Map();
  const backOmissionMap = new Map();
  for (let n = 1; n <= 35; n += 1) frontOmissionMap.set(n, 0);
  for (let n = 1; n <= 12; n += 1) backOmissionMap.set(n, 0);

  const frontSeen = new Set();
  const backSeen = new Set();
  const sums = [];
  const oddMap = new Map();
  const bigMap = new Map();
  const zoneCounts = [0, 0, 0, 0, 0];

  for (const draw of draws) {
    const front = draw.groups[0].balls.map(Number);
    const back = draw.groups[1].balls.map(Number);
    const frontSet = new Set(front);
    const backSet = new Set(back);

    for (const n of front) frontFreqMap.set(n, (frontFreqMap.get(n) || 0) + 1);
    for (const n of back) backFreqMap.set(n, (backFreqMap.get(n) || 0) + 1);

    for (let n = 1; n <= 35; n += 1) {
      if (frontSeen.has(n)) continue;
      if (frontSet.has(n)) frontSeen.add(n);
      else frontOmissionMap.set(n, frontOmissionMap.get(n) + 1);
    }
    for (let n = 1; n <= 12; n += 1) {
      if (backSeen.has(n)) continue;
      if (backSet.has(n)) backSeen.add(n);
      else backOmissionMap.set(n, backOmissionMap.get(n) + 1);
    }

    const sum = front.reduce((total, n) => total + n, 0);
    const span = Math.max(...front) - Math.min(...front);
    sums.push({ issue: draw.issue, date: draw.drawDate, sum, span });

    const odd = front.filter((n) => n % 2 === 1).length;
    const big = front.filter((n) => n >= 18).length;
    oddMap.set(odd, (oddMap.get(odd) || 0) + 1);
    bigMap.set(big, (bigMap.get(big) || 0) + 1);

    for (const n of front) {
      if (n <= 7) zoneCounts[0] += 1;
      else if (n <= 14) zoneCounts[1] += 1;
      else if (n <= 21) zoneCounts[2] += 1;
      else if (n <= 28) zoneCounts[3] += 1;
      else zoneCounts[4] += 1;
    }
  }

  const frontFreq = [...frontFreqMap.entries()]
    .map(([value, count]) => ({ value, count, omission: frontOmissionMap.get(value) }))
    .sort((a, b) => a.value - b.value);
  const backFreq = [...backFreqMap.entries()]
    .map(([value, count]) => ({ value, count, omission: backOmissionMap.get(value) }))
    .sort((a, b) => a.value - b.value);

  const hotFront = [...frontFreq].sort((a, b) => b.count - a.count || a.value - b.value).slice(0, 5);
  const hotBack = [...backFreq].sort((a, b) => b.count - a.count || a.value - b.value).slice(0, 5);
  const coldFront = [...frontFreq]
    .sort((a, b) => a.count - b.count || b.omission - a.omission || a.value - b.value)
    .slice(0, 5);
  const coldBack = [...backFreq]
    .sort((a, b) => a.count - b.count || b.omission - a.omission || a.value - b.value)
    .slice(0, 5);

  const oddEven = Array.from({ length: 6 }, (_, odd) => ({
    label: `${odd}奇${5 - odd}偶`,
    odd,
    count: oddMap.get(odd) || 0,
  }));
  const bigSmall = Array.from({ length: 6 }, (_, big) => ({
    label: `${big}大${5 - big}小`,
    big,
    count: bigMap.get(big) || 0,
  }));
  const zones = [
    { label: '一区 01-07', count: zoneCounts[0] },
    { label: '二区 08-14', count: zoneCounts[1] },
    { label: '三区 15-21', count: zoneCounts[2] },
    { label: '四区 22-28', count: zoneCounts[3] },
    { label: '五区 29-35', count: zoneCounts[4] },
  ];

  const average = (values) =>
    values.length ? Math.round((values.reduce((total, n) => total + n, 0) / values.length) * 10) / 10 : 0;

  const chronological = [...sums].reverse();

  return {
    success: true,
    game: GAME,
    limit,
    draws,
    stats: {
      total: draws.length,
      frontFreq,
      backFreq,
      frontOmission: frontFreq.map(({ value, omission }) => ({ value, omission })),
      backOmission: backFreq.map(({ value, omission }) => ({ value, omission })),
      hotFront,
      hotBack,
      coldFront,
      coldBack,
      sums: chronological,
      spans: chronological.map(({ issue, date, span }) => ({ issue, date, span })),
      oddEven,
      bigSmall,
      zones,
      averageSum: average(sums.map((item) => item.sum)),
      averageSpan: average(sums.map((item) => item.span)),
      latestIssue: draws[0]?.issue || '',
    },
  };
}

async function getAnalysis(limit) {
  const key = `analysis:${limit}`;
  const cached = getMemory(key);
  if (cached) return cached;
  const value = await getHistoryPage(1, limit);
  const result = buildAnalysis(value, limit);
  setMemory(key, result, 30_000);
  return result;
}

/* ============================================================
   用户设置：记住下期预测页「你的生日」上一次输入的日期
   单独落盘到 data/user-settings.json，避免与预测批次存档互相影响。
   写入串行化，防止连续修改时并发写坏文件。
   ============================================================ */

let settingsStore = null;
let settingsWriteChain = Promise.resolve();

function todayBeijing() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// 合法返回 YYYY-MM-DD；空串返回 ''（表示清除）；非法返回 null
function normalizeBirthday(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  if (y < 1900 || y > new Date().getUTCFullYear() + 1) return null;
  if (raw > todayBeijing()) return null; // 生日不能在未来
  return raw;
}

async function loadSettings() {
  if (settingsStore) return settingsStore;
  try {
    const parsed = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
    settingsStore = {
      lastBirthday: normalizeBirthday(parsed?.lastBirthday) || '',
      updatedAt: parsed?.updatedAt ? String(parsed.updatedAt).slice(0, 40) : null,
    };
  } catch {
    settingsStore = { lastBirthday: '', updatedAt: null };
  }
  return settingsStore;
}

function saveSettings() {
  if (!settingsStore) return Promise.resolve();
  const payload = JSON.stringify(settingsStore, null, 2);
  settingsWriteChain = settingsWriteChain
    .then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
      await fs.writeFile(SETTINGS_FILE, payload, 'utf8');
    })
    .catch((error) => {
      console.error('[settings] 写入失败:', error.message);
    });
  return settingsWriteChain;
}

function settingsState() {
  return {
    success: true,
    lastBirthday: settingsStore?.lastBirthday || '',
    updatedAt: settingsStore?.updatedAt || null,
  };
}

async function updateSettings(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'lastBirthday')) {
    const error = new Error('缺少 lastBirthday 字段');
    error.statusCode = 400;
    throw error;
  }
  const value = normalizeBirthday(body.lastBirthday);
  if (value === null) {
    const error = new Error('生日格式不正确，应为 YYYY-MM-DD 且不晚于今天');
    error.statusCode = 400;
    throw error;
  }
  const store = await loadSettings();
  if (store.lastBirthday !== value || !store.updatedAt) {
    store.lastBirthday = value;
    store.updatedAt = new Date().toISOString();
    await saveSettings();
  }
  return settingsState();
}

/* ============================================================
   下期预测批次：生成即落盘，开奖后自动结算中奖信息
   ============================================================ */

let predStore = null;
let predWriteChain = Promise.resolve();

async function loadPredictions() {
  if (predStore) return predStore;
  try {
    const text = await fs.readFile(PRED_FILE, 'utf8');
    const parsed = JSON.parse(text);
    predStore = {
      batches: Array.isArray(parsed?.batches) ? parsed.batches : [],
    };
  } catch {
    predStore = { batches: [] };
  }
  return predStore;
}

function savePredictions() {
  if (!predStore) return Promise.resolve();
  const payload = JSON.stringify(
    { updatedAt: new Date().toISOString(), batches: predStore.batches },
    null,
    2,
  );
  predWriteChain = predWriteChain
    .then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
      await fs.writeFile(PRED_FILE, payload, 'utf8');
    })
    .catch((error) => {
      console.error('[predictions] 写入失败:', error.message);
    });
  return predWriteChain;
}

// 由最新一期期号推导下一期期号（跨年时回到 YY001）
function computeNextIssue(latestIssue, nextDrawAt) {
  const n = Number.parseInt(latestIssue, 10);
  if (!Number.isFinite(n)) return null;
  const issueYear = Math.floor(n / 1000);
  let drawYear = issueYear;
  if (nextDrawAt) {
    const at = new Date(nextDrawAt);
    if (!Number.isNaN(at.getTime())) {
      const full = Number(
        new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(at),
      );
      if (Number.isFinite(full)) drawYear = full % 100;
    }
  }
  if (drawYear !== issueYear) return `${String(drawYear).padStart(2, '0')}001`;
  return String(n + 1);
}

function normalizeBallList(raw, length, min, max) {
  if (!Array.isArray(raw) || raw.length !== length) return null;
  const values = raw.map((item) => Number(item));
  if (!values.every((n) => Number.isInteger(n) && n >= min && n <= max)) return null;
  if (new Set(values).size !== length) return null;
  return values.sort((a, b) => a - b);
}

function settleBatch(batch, draw) {
  const actualFront = draw.groups[0].balls.map(Number);
  const actualBack = draw.groups[1].balls.map(Number);
  const prizeByName = new Map((draw.prizeLevels || []).map((prize) => [prize.name, prize]));

  let winCount = 0;
  let bestTier = null;

  batch.results = batch.results.map((pick) => {
    const frontHits = pick.front.filter((n) => actualFront.includes(n)).length;
    const backHits = pick.back.filter((n) => actualBack.includes(n)).length;
    const tier = DLT_TIERS[`${frontHits}+${backHits}`] || null;
    const prize = tier ? prizeByName.get(tier) : null;
    if (tier) {
      winCount += 1;
      if (!bestTier || TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(bestTier)) bestTier = tier;
    }
    return {
      ...pick,
      frontHits,
      backHits,
      tier,
      prizeAmount: prize?.amount ?? null,
      frontHitFlags: pick.front.map((n) => actualFront.includes(n)),
      backHitFlags: pick.back.map((n) => actualBack.includes(n)),
    };
  });

  batch.status = 'settled';
  batch.settledAt = new Date().toISOString();
  batch.winCount = winCount;
  batch.bestTier = bestTier;
  batch.draw = {
    issue: draw.issue,
    drawDate: draw.drawDate,
    resultText: draw.resultText,
    groups: draw.groups,
    prizeLevels: draw.prizeLevels || [],
  };
  return true;
}

async function settlePendingBatches() {
  const store = await loadPredictions();
  const pending = store.batches.filter((batch) => batch.status === 'pending');
  if (!pending.length) return false;

  let latest = null;
  try {
    latest = await getLatest();
  } catch {
    return false;
  }

  let changed = false;
  for (const batch of pending) {
    // 最新一期仍是生成时的期号 → 还没开奖
    if (String(latest.issue) === String(batch.baseIssue)) continue;

    let draw = null;
    if (String(latest.issue) === String(batch.targetIssue)) {
      draw = latest;
    } else {
      try {
        const raw = await findIssue(batch.targetIssue);
        if (raw) draw = normalizeDraw(raw);
      } catch {
        draw = null;
      }
    }
    if (!draw || String(draw.issue) !== String(batch.targetIssue)) continue;
    if (settleBatch(batch, draw)) changed = true;
  }
  if (changed) await savePredictions();
  return changed;
}

async function getPredictionState() {
  await settlePendingBatches();
  const store = await loadPredictions();

  let latest = null;
  try {
    latest = await getLatest();
  } catch {
    latest = null;
  }

  const nextIssue = latest ? computeNextIssue(latest.issue, latest.next?.drawAt) : null;
  const active = store.batches.find(
    (batch) => batch.status === 'pending' && String(batch.targetIssue) === String(nextIssue),
  );

  return {
    success: true,
    asOf: new Date().toISOString(),
    latestIssue: latest?.issue || null,
    nextIssue,
    nextDrawAt: latest?.next?.drawAt || null,
    activeBatch: active || null,
    batches: store.batches,
  };
}

async function createPredictionBatch(body) {
  const store = await loadPredictions();

  const baseIssue = String(body?.baseIssue ?? '').trim();
  const targetIssue = String(body?.targetIssue ?? '').trim();
  if (!/^\d{5,7}$/.test(baseIssue) || !/^\d{5,7}$/.test(targetIssue)) {
    const error = new Error('期号格式不正确');
    error.statusCode = 400;
    throw error;
  }

  const incoming = Array.isArray(body?.results) ? body.results.slice(0, MAX_PICKS) : [];
  if (!incoming.length) {
    const error = new Error('缺少号码数据');
    error.statusCode = 400;
    throw error;
  }

  const results = [];
  for (const item of incoming) {
    const front = normalizeBallList(item?.front, 5, 1, 35);
    const back = normalizeBallList(item?.back, 2, 1, 12);
    if (!front || !back) {
      const error = new Error('号码格式不正确');
      error.statusCode = 400;
      throw error;
    }
    results.push({
      front,
      back,
      method: METHOD_KEYS.has(item?.method) ? item.method : 'random',
      reason: String(item?.reason ?? '').slice(0, 240),
      features: item?.features && typeof item.features === 'object' ? item.features : null,
    });
  }

  const batch = {
    id: `${targetIssue}-${Date.now()}`,
    baseIssue,
    targetIssue,
    targetDrawAt: body?.targetDrawAt ? String(body.targetDrawAt) : null,
    createdAt: new Date().toISOString(),
    status: 'pending',
    methods: Array.isArray(body?.methods)
      ? body.methods.filter((key) => METHOD_KEYS.has(key))
      : [],
    birthday: String(body?.birthday ?? '').slice(0, 20),
    seed: String(body?.seed ?? '').slice(0, 40),
    analysisLimit: Number(body?.analysisLimit) || null,
    results,
    winCount: 0,
    bestTier: null,
    draw: null,
  };

  // 同一期只保留一份：重复生成视为覆盖（换一批已移除，正常不会走到这里）
  const existingIndex = store.batches.findIndex(
    (item) => item.status === 'pending' && String(item.targetIssue) === String(targetIssue),
  );
  if (existingIndex >= 0) {
    batch.id = store.batches[existingIndex].id;
    store.batches.splice(existingIndex, 1);
  }
  store.batches.unshift(batch);
  if (store.batches.length > MAX_BATCHES) store.batches.length = MAX_BATCHES;

  await savePredictions();
  return batch;
}

async function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function serveStatic(req, res, pathname) {
  let pathPart = pathname === '/' ? '/index.html' : pathname;
  try {
    pathPart = decodeURIComponent(pathPart);
  } catch {
    return text(res, 400, 'Bad request');
  }
  const filePath = path.resolve(PUBLIC_DIR, `.${pathPart}`);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    return text(res, 403, 'Forbidden');
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not file');
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control':
        ext === '.html' || ext === '.css' || ext === '.js'
          ? 'no-store, must-revalidate'
          : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    text(res, 404, '页面不存在');
  }
}

async function route(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (pathname === '/api/predictions') {
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const batch = await createPredictionBatch(body);
      const state = await getPredictionState();
      return json(res, 200, { ...state, created: batch });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return json(res, 200, await getPredictionState());
    }
    return json(res, 405, { success: false, error: '仅支持 GET / POST 请求' });
  }

  // 「你的生日」上一次输入的日期：GET 读取 / POST 保存
  if (pathname === '/api/settings') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      await loadSettings();
      return json(res, 200, settingsState());
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      return json(res, 200, await updateSettings(body));
    }
    return json(res, 405, { success: false, error: '仅支持 GET / POST 请求' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { success: false, error: '仅支持 GET 请求' });
  }

  if (pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      game: GAME.name,
      source: SOURCE_NAME,
      time: new Date().toISOString(),
    });
  }

  if (pathname === '/api/overview') {
    const force = url.searchParams.get('force') === '1';
    return json(res, 200, await getOverview(force));
  }

  if (pathname === '/api/history') {
    const page = clampInt(url.searchParams.get('page'), 1, 9999, 1);
    const pageSize = clampInt(url.searchParams.get('pageSize'), 1, 50, 10);
    return json(res, 200, await getHistory(page, pageSize));
  }

  if (pathname === '/api/draw') {
    const issue = (url.searchParams.get('issue') || 'latest').trim();
    let raw;

    if (issue === 'latest') {
      const value = await fetchPage(1, 1);
      raw = (value.list && value.list[0]) || value.lastPoolDraw;
    } else {
      if (!/^\d{5,7}$/.test(issue)) {
        return json(res, 400, { success: false, error: '期号格式不正确' });
      }
      raw = await findIssue(issue);
    }

    if (!raw || !raw.lotteryDrawNum) {
      return json(res, 404, { success: false, error: `未找到第 ${issue} 期开奖数据` });
    }

    const draw = normalizeDraw(raw);
    draw.next = nextDraw();
    return json(res, 200, { success: true, draw });
  }

  if (pathname === '/api/analysis') {
    const limit = clampInt(url.searchParams.get('limit'), 20, 100, 50);
    return json(res, 200, await getAnalysis(limit));
  }

  if (pathname.startsWith('/api/')) {
    return json(res, 404, { success: false, error: '接口不存在' });
  }

  return serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    const status = error.statusCode || 502;
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.url} -> ${status}`, error.message);
    if (!res.headersSent) {
      json(res, status, {
        success: false,
        error: error.message || '服务器开小差了，请稍后重试',
      });
    } else {
      res.end();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`大乐透数据中心已启动: http://${HOST}:${PORT}`);
  console.log(`数据源: ${SOURCE_NAME} (${UPSTREAM})`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
