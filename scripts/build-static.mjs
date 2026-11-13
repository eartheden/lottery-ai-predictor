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
// 仓库里的快照副本：本机抓一次提交上来，GitHub Actions 就用它发布
const SNAPSHOT_FILE = path.join(ROOT, 'data', 'offline.json');
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
  // GitHub Actions 的出口 IP 在境外，体彩官网会直接 567 拒绝，所以那边不走实时抓取，
  // 直接用仓库里已经提交的快照。本机跑的时候默认实时抓，抓失败了再退回旧快照。
  const useSnapshotOnly = process.env.USE_SNAPSHOT === '1' || process.argv.includes('--snapshot');

  let bundle = null;

  if (useSnapshotOnly) {
    bundle = await readSnapshot();
    if (!bundle) throw new Error('没有可用的仓库快照，先在本机跑一次不带 --snapshot 的构建');
    console.log(`使用仓库快照：${bundle.latestIssue} 期 · ${bundle.generatedAt}`);
  } else {
    bundle = await collectLive();
    if (bundle) {
      await fs.mkdir(path.dirname(SNAPSHOT_FILE), { recursive: true });
      await fs.writeFile(SNAPSHOT_FILE, JSON.stringify(bundle), 'utf8');
    } else {
      console.warn('\n实时抓取失败，退回仓库快照继续构建');
      bundle = await readSnapshot();
      if (!bundle) throw new Error('实时抓取失败，且仓库里没有可用快照');
      console.log(`使用仓库快照：${bundle.latestIssue} 期 · ${bundle.generatedAt}`);
    }
  }

  console.log('· 生成 docs/');
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await copyDir(PUBLIC_DIR, OUT_DIR);
  await fs.mkdir(path.join(OUT_DIR, 'data'), { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, 'data', 'offline.json'), JSON.stringify(bundle), 'utf8');
  await fs.writeFile(path.join(OUT_DIR, '.nojekyll'), '', 'utf8');

  const kb = (JSON.stringify(bundle).length / 1024).toFixed(0);
  console.log(
    `\n完成：${bundle.draws.length} 期开奖 / 分析 ${Object.keys(bundle.analysis).join(',')}` +
      `  数据 ${kb} KB  期号 ${bundle.latestIssue}`,
  );
  console.log(`输出目录：${OUT_DIR}`);
}

async function readSnapshot() {
  try {
    return JSON.parse(await fs.readFile(SNAPSHOT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** 拉起临时后端做实时快照；失败返回 null 交给上层降级 */
async function collectLive() {
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
    return await collect();
  } catch (error) {
    console.warn('实时快照失败:', error.message);
    const tail = stderr.trim().split('\n').slice(-3).join('\n');
    if (tail) console.warn(tail);
    return null;
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error('\n构建失败:', error.message);
  process.exit(1);
});
