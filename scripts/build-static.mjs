#!/usr/bin/env node
/**
 * 把「需要 Node 后端」的彩票站点，打包成可以放到 GitHub Pages 的纯静态站点。
 *
 * 思路：不在前端重写一套分析逻辑，而是直接把真实后端跑起来，
 * 把它吐出来的 /api/* 响应原样快照成 JSON，前端再用 offline.js 顶上这些接口。
 * 好处是分析口径永远跟后端一致，后端改了什么，重新跑一次快照就是最新的。
 *
 * 用法：node scripts/build-static.mjs
 * 产物：docs/（可直接作为 Pages 发布目录）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_DIR = path.join(ROOT, 'docs');
const PORT = 8911;
const BASE = `http://127.0.0.1:${PORT}`;

const HISTORY_PAGES = 12; // 12 × 50 期 ≈ 近 4 年，足够历史页与期号查询
const PAGE_SIZE = 50; // 上游单页上限就是 50，传更大也只回 50
const ANALYSIS_LIMITS = [20, 50, 100];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  throw new Error('后端 30 秒内没起来');
}

async function getJson(pathname) {
  const response = await fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${pathname} -> HTTP ${response.status}`);
  const data = await response.json();
  if (data?.success === false) throw new Error(`${pathname} -> ${data?.error || '上游失败'}`);
  return data;
}

async function collect() {
  console.log('· 拉取最新一期 /api/overview');
  const overview = await getJson('/api/overview?force=1');
  if (!overview?.game?.issue) throw new Error('overview 里没有期号，上游可能挂了');

  console.log('· 拉取历史开奖');
  const draws = [];
  for (let page = 1; page <= HISTORY_PAGES; page += 1) {
    const data = await getJson(`/api/history?page=${page}&pageSize=${PAGE_SIZE}`);
    const list = Array.isArray(data.draws) ? data.draws : [];
    draws.push(...list);
    console.log(`  page ${page}: ${list.length} 期`);
    if (list.length < PAGE_SIZE) break;
  }
  if (!draws.length) throw new Error('历史开奖为空');

  console.log('· 拉取走势分析');
  const analysis = {};
  for (const limit of ANALYSIS_LIMITS) {
    analysis[limit] = await getJson(`/api/analysis?limit=${limit}`);
    console.log(`  limit=${limit} ok`);
  }

  return {
    generatedAt: new Date().toISOString(),
    latestIssue: String(overview.game.issue),
    nextDrawAt: overview.game?.next?.drawAt || null,
    overview,
    draws,
    analysis,
  };
}

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dest);
    else await fs.copyFile(src, dest);
  }
}

async function main() {
  console.log('启动临时后端用于快照…');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer();
    const bundle = await collect();

    console.log('· 生成 docs/');
    await fs.rm(OUT_DIR, { recursive: true, force: true });
    await copyDir(PUBLIC_DIR, OUT_DIR);
    await fs.mkdir(path.join(OUT_DIR, 'data'), { recursive: true });
    await fs.writeFile(
      path.join(OUT_DIR, 'data', 'offline.json'),
      JSON.stringify(bundle),
      'utf8',
    );
    await fs.writeFile(path.join(OUT_DIR, '.nojekyll'), '', 'utf8');

    const kb = (JSON.stringify(bundle).length / 1024).toFixed(0);
    console.log(`\n完成：${draws_digest(bundle)}  数据 ${kb} KB  期号 ${bundle.latestIssue}`);
    console.log(`输出目录：${OUT_DIR}`);
  } finally {
    child.kill('SIGTERM');
    if (stderr.trim()) console.log('\n[后端日志]\n' + stderr.trim().split('\n').slice(-5).join('\n'));
  }
}

function draws_digest(bundle) {
  return `${bundle.draws.length} 期开奖 / 分析 ${Object.keys(bundle.analysis).join(',')}`;
}

main().catch((error) => {
  console.error('\n构建失败:', error.message);
  process.exit(1);
});
