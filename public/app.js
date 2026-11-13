(() => {
  'use strict';

  // 超级大乐透现行 7 个奖级（2026 年规则）：
  // 一等奖 5+2；二等奖 5+1；三等奖 5+0 / 4+2；四等奖 4+1；
  // 五等奖 4+0 / 3+2；六等奖 3+1 / 2+2；七等奖 3+0 / 2+1 / 1+2 / 0+2。
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

  const METHODS = {
    birthday: { label: '生日 + 今日时间', short: '生日', color: 'purple' },
    random: { label: '随机灵感', short: '随机', color: 'blue' },
    ai: { label: 'AI 多维集成', short: 'AI', color: 'teal' },
    cosmos: { label: '宇宙通识常量', short: '宇宙', color: 'violet' },
    chaos: { label: '混沌动力学', short: '混沌', color: 'orange' },
    markov: { label: '马尔可夫链', short: '链式', color: 'green' },
    // 已下线策略：仅用于历史批次回显，新生成不再可选
    history: { label: '历史热度（已下线）', short: '热度', color: 'red', retired: true },
    omission: { label: '遗漏回补（已下线）', short: '遗漏', color: 'gold', retired: true },
  };

  // 生成组数固定为 5 组，不再提供 3/8/10 选项
  const PICK_COUNT = 5;

  const state = {
    overview: null,
    analysis: null,
    analysisLimit: 50,
    analysisFetchedAt: null,
    analysisToken: 0,
    refreshing: false,
    lastRefreshAt: 0,
    view: 'home',
    history: {
      page: 1,
      pageSize: 10,
      total: 0,
      pages: 0,
      loaded: false,
      token: 0,
      search: null,
    },
    prediction: {
      count: PICK_COUNT,
      results: [],
      busy: false,
      nonce: 0,
      generatedAt: null,
      methods: [],
      analysisLimit: 50,
      activeBatch: null,
      batches: [],
      latestIssue: null,
      nextIssue: null,
      nextDrawAt: null,
      loaded: false,
    },
    toastTimer: null,
  };

  const refs = {};
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function cacheRefs() {
    const ids = [
      'syncState',
      'syncText',
      'refreshBtn',
      'heroRefresh',
      'statIssue',
      'statPool',
      'statSync',
      'heroCard',
      'quickStats',
      'historyBody',
      'historyEmpty',
      'pagination',
      'issueInput',
      'issueSearchBtn',
      'searchResultBar',
      'searchResultText',
      'clearSearchBtn',
      'checkForm',
      'checkRule',
      'checkResult',
      'checkBtn',
      'randomBtn',
      'clearBtn',
      'trendPeriod',
      'trendUpdated',
      'trendInsights',
      'chartFrontFreq',
      'chartBackFreq',
      'chartSpan',
      'chartSum',
      'chartOdd',
      'chartBig',
      'chartZone',
      'chartOmission',
      'chartMatrix',
      'sumBadge',
      'predictTime',
      'predictCount',
      'birthdayInput',
      'birthdayMemory',
      'birthdayMemoryEmpty',
      'birthdayMemoryValue',
      'birthdayMemoryTime',
      'birthdayMemoryFill',
      'methodList',
      'generateBtn',
      'copyAllBtn',
      'predictSummary',
      'predictStatus',
      'predictResults',
      'predictHistory',
      'detailDialog',
      'dialogClose',
      'dialogBody',
      'toast',
    ];
    for (const id of ids) refs[id] = document.getElementById(id);
    refs.syncDot = refs.syncState.querySelector('.sync-dot');
    refs.tableWrap = $('.history-table').closest('.table-wrap');
    refs.dialogInner = $('.dialog-inner');
    refs.navBtns = $$('.nav-btn');
    refs.views = $$('.view');
  }

  async function api(path) {
    const response = await fetch(path, { cache: 'no-store', headers: { Accept: 'application/json' } });
    let data = null;
    try {
      data = await response.json();
    } catch {
      // ignore malformed JSON
    }
    if (!response.ok || data?.success === false) {
      throw new Error(data?.error || `请求失败（${response.status}）`);
    }
    return data;
  }

  async function apiPost(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      // ignore malformed JSON
    }
    if (!response.ok || data?.success === false) {
      throw new Error(data?.error || `请求失败（${response.status}）`);
    }
    return data;
  }

  const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (char) => {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return map[char];
    });

  const pad2 = (value) => String(value).padStart(2, '0');

  function formatNum(value) {
    return Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '—';
  }

  function formatCny(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n >= 100_000_000) return `¥${(n / 100_000_000).toFixed(2)}亿`;
    if (n >= 10_000) return `¥${(n / 10_000).toFixed(1)}万`;
    return `¥${Math.round(n).toLocaleString('zh-CN')}`;
  }

  function formatExactCny(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '—';
    return `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
  }

  function formatClock(input) {
    if (!input) return '—';
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatDateTime(date = new Date()) {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .format(date)
      .replace(/\//g, '-');
  }

  function formatToday() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  function shortDate(value) {
    return value ? String(value).slice(5) : '—';
  }

  function setSync(mode, text) {
    refs.syncDot.className = `sync-dot${mode === 'loading' ? ' is-loading' : mode === 'error' ? ' is-error' : ''}`;
    refs.syncText.textContent = text;
    refs.syncState.title = text;
  }

  function showToast(message, type = '') {
    window.clearTimeout(state.toastTimer);
    refs.toast.textContent = message;
    refs.toast.className = `toast is-visible${type === 'error' ? ' is-error' : ''}`;
    state.toastTimer = window.setTimeout(() => {
      refs.toast.className = 'toast';
    }, 2800);
  }

  function ballHtml(value, tone = 'red', extra = '') {
    return `<span class="ball ball-${tone}${extra ? ` ${extra}` : ''}">${escapeHtml(value)}</span>`;
  }

  function ballsHtml(values, tone = 'red', extra = 'sm') {
    return values.map((value) => ballHtml(value, tone, extra)).join('');
  }

  function groupsHtml(draw, large = false) {
    return draw.groups
      .map(
        (group) => `
        <div class="number-group">
          <span class="group-label">${escapeHtml(group.label)}</span>
          <div class="balls">${group.balls.map((value) => ballHtml(value, group.tone, large ? 'lg' : '')).join('')}</div>
        </div>`,
      )
      .join('');
  }

  function countdownHtml(next, label = '距下期停售') {
    if (!next) {
      return '<div class="countdown-row"><span>下期开奖</span><b class="countdown-time">以官方公告为准</b></div>';
    }
    return `<div class="countdown-row"><span>${escapeHtml(label)}</span><b class="countdown-time" data-countdown="${escapeHtml(
      next.saleAt,
    )}">--:--:--</b></div>`;
  }

  function updateCountdowns() {
    const now = Date.now();
    $$('[data-countdown]').forEach((node) => {
      const target = Date.parse(node.dataset.countdown);
      if (!Number.isFinite(target)) return;
      const diff = target - now;
      node.textContent = diff <= 0 ? '已截止' : formatCountdown(diff);
      node.classList.toggle('is-soon', diff > 0 && diff < 10 * 60 * 1000);
    });
  }

  function formatCountdown(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (days > 0) return `${days}天 ${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
    return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  }

  function computeFeatures(front, back) {
    const sum = front.reduce((total, n) => total + n, 0);
    const span = Math.max(...front) - Math.min(...front);
    const odd = front.filter((n) => n % 2 === 1).length;
    const big = front.filter((n) => n >= 18).length;
    const zones = [0, 0, 0, 0, 0];
    for (const n of front) {
      if (n <= 7) zones[0] += 1;
      else if (n <= 14) zones[1] += 1;
      else if (n <= 21) zones[2] += 1;
      else if (n <= 28) zones[3] += 1;
      else zones[4] += 1;
    }
    return {
      sum,
      span,
      odd,
      big,
      zones,
      structure: `${odd}奇${5 - odd}偶 · ${big}大${5 - big}小`,
      backSum: back.reduce((total, n) => total + n, 0),
    };
  }

  function renderOverviewStats() {
    const draw = state.overview?.game;
    if (!draw) return;
    refs.statIssue.textContent = draw.issue || '—';
    refs.statPool.textContent = formatCny(draw.pool);
    refs.statSync.textContent = formatClock(state.overview.updatedAt);
  }

  function renderHero() {
    const draw = state.overview?.game;
    if (!draw) {
      refs.heroCard.innerHTML = `
        <div class="result-placeholder" style="min-height:360px">
          <span class="empty-icon">!</span>
          <strong>暂时无法获取大乐透数据</strong>
          <p>请稍后刷新重试。</p>
        </div>`;
      return;
    }

    refs.heroCard.innerHTML = `
      <div class="hero-card-top">
        <span class="badge"><span class="live-dot"></span> 最新开奖</span>
        <span class="issue-pill">第 ${escapeHtml(draw.issue)} 期</span>
      </div>
      <div class="hero-card-title">
        <span class="glyph">大</span>
        <div>
          <h2>超级大乐透</h2>
          <p>${escapeHtml(draw.drawDate)} 开奖 · 前区 5 + 后区 2</p>
        </div>
      </div>
      <div class="feature-numbers">${groupsHtml(draw, true)}</div>
      <div class="feature-meta">
        <div><span>奖池滚存</span><strong>${formatCny(draw.pool)}</strong></div>
        <div><span>本期销量</span><strong>${formatCny(draw.sales)}</strong></div>
      </div>
      ${countdownHtml(draw.next)}
      <button class="btn btn-primary full" type="button" data-open-issue="${escapeHtml(draw.issue)}">
        查看本期详情 <span>→</span>
      </button>`;
    updateCountdowns();
  }

  function renderQuickStats() {
    if (!state.analysis) return;
    const stats = state.analysis.stats;
    const hotFront = stats.hotFront.slice(0, 3);
    const hotBack = stats.hotBack.slice(0, 2);
    const mainOdd = [...stats.oddEven].sort((a, b) => b.count - a.count)[0];
    const mainBig = [...stats.bigSmall].sort((a, b) => b.count - a.count)[0];

    refs.quickStats.innerHTML = `
      <div class="quick-stat">
        <div class="quick-label">前区热号 <em>近 ${state.analysisLimit} 期</em></div>
        <div class="quick-balls">${hotFront.map((item) => ballHtml(pad2(item.value), 'red', 'sm')).join('')}</div>
        <div class="quick-sub">${hotFront.map((item) => `${pad2(item.value)} ${item.count}次`).join(' · ')}</div>
      </div>
      <div class="quick-stat">
        <div class="quick-label">后区热号 <em>近 ${state.analysisLimit} 期</em></div>
        <div class="quick-balls">${hotBack.map((item) => ballHtml(pad2(item.value), 'blue', 'sm')).join('')}</div>
        <div class="quick-sub">${hotBack.map((item) => `${pad2(item.value)} ${item.count}次`).join(' · ')}</div>
      </div>
      <div class="quick-stat">
        <div class="quick-label">平均和值</div>
        <div class="quick-value">${stats.averageSum}</div>
        <div class="quick-sub">平均跨度 ${stats.averageSpan}</div>
      </div>
      <div class="quick-stat">
        <div class="quick-label">主流结构</div>
        <div class="quick-value">${mainOdd.label}</div>
        <div class="quick-sub">${mainOdd.label} ${mainOdd.count} 期 · ${mainBig.label} ${mainBig.count} 期</div>
      </div>`;
  }

  function historyRow(draw) {
    const front = draw.groups[0]?.balls || [];
    const back = draw.groups[1]?.balls || [];
    return `
      <tr data-open-issue="${escapeHtml(draw.issue)}" tabindex="0">
        <td><span class="issue-cell">${escapeHtml(draw.issue)}</span></td>
        <td>${escapeHtml(draw.drawDate || '—')}</td>
        <td><div class="table-numbers">${ballsHtml(front, 'red', 'sm')}</div></td>
        <td><div class="table-numbers">${ballsHtml(back, 'blue', 'sm')}</div></td>
        <td class="table-muted">${formatCny(draw.sales)}</td>
        <td class="table-muted">${formatCny(draw.pool)}</td>
        <td><button class="row-link" type="button" data-open-issue="${escapeHtml(draw.issue)}">→</button></td>
      </tr>`;
  }

  function showHistoryEmpty(title, subtitle) {
    refs.historyBody.innerHTML = '';
    refs.tableWrap.hidden = true;
    refs.historyEmpty.hidden = false;
    refs.historyEmpty.innerHTML = `
      <span class="empty-icon">⌕</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(subtitle)}</p>`;
  }

  function renderHistory(draws) {
    if (!draws.length) {
      showHistoryEmpty('暂无开奖记录', '换一个期号试试。');
      return;
    }
    refs.tableWrap.hidden = false;
    refs.historyEmpty.hidden = true;
    refs.historyBody.innerHTML = draws.map(historyRow).join('');
  }

  function renderPagination() {
    const history = state.history;
    if (history.search) {
      refs.pagination.innerHTML = '<span class="page-meta">期号检索模式 · 共 1 条</span>';
      return;
    }
    if (!history.total) {
      refs.pagination.innerHTML = '';
      return;
    }
    if ((history.pages || 0) <= 1) {
      refs.pagination.innerHTML = `<span class="page-meta">共 ${formatNum(history.total)} 期</span>`;
      return;
    }

    const pageSet = new Set([1, history.pages, history.page, history.page - 1, history.page + 1]);
    const pages = [...pageSet].filter((page) => page >= 1 && page <= history.pages).sort((a, b) => a - b);
    let html = `<span class="page-meta">共 ${formatNum(history.total)} 期 · 第 ${history.page} / ${history.pages} 页</span>`;
    html += `<button class="page-btn" type="button" data-page="${history.page - 1}" ${
      history.page <= 1 ? 'disabled' : ''
    } aria-label="上一页">‹</button>`;
    let previous = 0;
    for (const page of pages) {
      if (page - previous > 1) html += '<span class="page-ellipsis">…</span>';
      html += `<button class="page-btn${page === history.page ? ' is-active' : ''}" type="button" data-page="${page}">${page}</button>`;
      previous = page;
    }
    html += `<button class="page-btn" type="button" data-page="${history.page + 1}" ${
      history.page >= history.pages ? 'disabled' : ''
    } aria-label="下一页">›</button>`;
    refs.pagination.innerHTML = html;
  }

  async function loadHistory() {
    const history = state.history;
    const token = ++history.token;
    history.search = null;
    refs.searchResultBar.hidden = true;
    refs.issueInput.value = '';
    refs.tableWrap.hidden = false;
    refs.historyEmpty.hidden = true;
    refs.historyBody.innerHTML = `<tr><td colspan="7" class="table-muted" style="text-align:center;padding:44px 0">正在加载开奖记录…</td></tr>`;
    refs.pagination.innerHTML = '';

    try {
      const data = await api(`/api/history?page=${history.page}&pageSize=${history.pageSize}`);
      if (token !== history.token) return;
      history.total = data.total;
      history.pages = data.pages;
      history.page = data.page;
      history.loaded = true;
      renderHistory(data.draws || []);
      renderPagination();
    } catch (error) {
      if (token !== history.token) return;
      showHistoryEmpty('加载失败', error.message || '请稍后重试。');
      showToast(error.message || '开奖记录加载失败', 'error');
    }
  }

  async function searchIssue() {
    const issue = refs.issueInput.value.trim();
    if (!/^\d{5,7}$/.test(issue)) {
      showToast('请输入 5-7 位数字期号，例如 26123', 'error');
      refs.issueInput.focus();
      return;
    }

    const history = state.history;
    const token = ++history.token;
    history.search = { issue };
    refs.searchResultBar.hidden = false;
    refs.searchResultText.textContent = `正在检索第 ${issue} 期…`;
    refs.tableWrap.hidden = false;
    refs.historyEmpty.hidden = true;
    refs.historyBody.innerHTML = `<tr><td colspan="7" class="table-muted" style="text-align:center;padding:44px 0">正在检索第 ${escapeHtml(
      issue,
    )} 期…</td></tr>`;
    refs.pagination.innerHTML = '';

    try {
      const data = await api(`/api/draw?issue=${encodeURIComponent(issue)}`);
      if (token !== history.token) return;
      history.loaded = true;
      renderHistory([data.draw]);
      refs.searchResultText.textContent = `检索到第 ${data.draw.issue} 期 · ${data.draw.drawDate}`;
      renderPagination();
    } catch (error) {
      if (token !== history.token) return;
      showHistoryEmpty(`未找到第 ${issue} 期`, '请检查期号是否正确，或返回全部记录继续浏览。');
      refs.searchResultText.textContent = `第 ${issue} 期没有找到开奖记录`;
      refs.pagination.innerHTML = '<span class="page-meta">期号检索模式</span>';
      showToast(error.message || '未找到该期开奖数据', 'error');
    }
  }

  function clearHistorySearch() {
    state.history.search = null;
    state.history.page = 1;
    refs.issueInput.value = '';
    refs.searchResultBar.hidden = true;
    loadHistory();
  }

  function goToHistoryPage(page) {
    const history = state.history;
    history.page = page;
    history.search = null;
    refs.searchResultBar.hidden = true;
    const token = ++history.token;
    refs.historyBody.innerHTML = `<tr><td colspan="7" class="table-muted" style="text-align:center;padding:44px 0">正在加载第 ${page} 页…</td></tr>`;
    refs.pagination.innerHTML = '';
    api(`/api/history?page=${page}&pageSize=${history.pageSize}`)
      .then((data) => {
        if (token !== history.token) return;
        history.total = data.total;
        history.pages = data.pages;
        history.page = data.page;
        renderHistory(data.draws || []);
        renderPagination();
      })
      .catch((error) => {
        if (token !== history.token) return;
        showHistoryEmpty('加载失败', error.message || '请稍后重试。');
        showToast(error.message || '开奖记录加载失败', 'error');
      });
  }

  function checkInput(index, group, min, max, len) {
    return `<input class="number-input" type="text" inputmode="numeric" autocomplete="off" maxlength="${len}"
      data-min="${min}" data-max="${max}" data-len="${len}" data-group="${group}" aria-label="${group}第 ${index + 1} 位" />`;
  }

  function renderCheckForm() {
    refs.checkForm.innerHTML = `
      <div class="check-zone">
        <span class="zone-label">前区 · 5 个</span>
        <div class="number-inputs">${Array.from({ length: 5 }, (_, i) => checkInput(i, '前区', 1, 35, 2)).join('')}</div>
      </div>
      <span class="check-separator">+</span>
      <div class="check-zone">
        <span class="zone-label">后区 · 2 个</span>
        <div class="number-inputs">${Array.from({ length: 2 }, (_, i) => checkInput(i, '后区', 1, 12, 2)).join('')}</div>
      </div>`;
    bindCheckInputs();
  }

  function bindCheckInputs() {
    const inputs = $$('.number-input', refs.checkForm);
    inputs.forEach((input, index) => {
      input.addEventListener('input', () => {
        const maxLength = Number(input.dataset.len) || 2;
        input.value = input.value.replace(/[^\d]/g, '').slice(0, maxLength);
        input.classList.remove('is-invalid');
        if (input.value.length >= maxLength && inputs[index + 1]) inputs[index + 1].focus();
      });
      input.addEventListener('blur', () => {
        if (input.value && input.dataset.len === '2') input.value = input.value.padStart(2, '0');
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Backspace' && !input.value && inputs[index - 1]) inputs[index - 1].focus();
        if (event.key === 'Enter') {
          event.preventDefault();
          checkNumbers();
        }
      });
      input.addEventListener('focus', () => input.select());
    });
  }

  function sampleNumbers(min, max, count) {
    const pool = [];
    for (let n = min; n <= max; n += 1) pool.push(n);
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count).sort((a, b) => a - b);
  }

  function randomCheck() {
    const values = [...sampleNumbers(1, 35, 5).map(pad2), ...sampleNumbers(1, 12, 2).map(pad2)];
    $$('.number-input', refs.checkForm).forEach((input, index) => {
      input.value = values[index] || '';
      input.classList.remove('is-invalid');
    });
    refs.checkForm.querySelector('.number-input')?.focus();
  }

  function clearCheck() {
    $$('.number-input', refs.checkForm).forEach((input) => {
      input.value = '';
      input.classList.remove('is-invalid');
    });
    refs.checkResult.innerHTML = '<span class="mini-muted">填写号码后查看命中情况</span>';
    refs.checkRule.textContent = '与最新一期比对前区 5 个 + 后区 2 个号码 · 参考奖级未区分追加';
  }

  function collectCheckNumbers() {
    const inputs = $$('.number-input', refs.checkForm);
    const values = [];
    for (const input of inputs) {
      const raw = input.value.trim();
      const min = Number(input.dataset.min);
      const max = Number(input.dataset.max);
      if (!raw) {
        input.classList.add('is-invalid');
        input.focus();
        showToast('请先填写完整号码', 'error');
        return null;
      }
      const value = Number(raw);
      if (!Number.isInteger(value) || value < min || value > max) {
        input.classList.add('is-invalid');
        input.focus();
        showToast(`号码需在 ${pad2(min)}-${pad2(max)} 之间`, 'error');
        return null;
      }
      values.push(value);
    }
    const front = values.slice(0, 5);
    const back = values.slice(5);
    if (new Set(front).size !== 5 || new Set(back).size !== 2) {
      showToast('同一区域内不能填写重复号码', 'error');
      return null;
    }
    return { front, back };
  }

  function renderCheckMini(draw, front, back) {
    const actualFront = draw.groups[0].balls.map(Number);
    const actualBack = draw.groups[1].balls.map(Number);
    const frontHits = front.filter((n) => actualFront.includes(n)).length;
    const backHits = back.filter((n) => actualBack.includes(n)).length;
    const tier = DLT_TIERS[`${frontHits}+${backHits}`] || null;

    refs.checkRule.textContent = `与第 ${draw.issue} 期（${draw.drawDate}）比对 · 参考奖级未区分追加`;
    refs.checkResult.innerHTML = `
      <div class="mini-head">
        <strong class="${tier ? 'is-win' : ''}">${tier || '未达到参考奖级'}</strong>
        <span>前区 ${frontHits} · 后区 ${backHits}</span>
      </div>
      <div class="mini-balls">
        ${front
          .map((n) => ballHtml(pad2(n), 'red', actualFront.includes(n) ? 'ball-hit' : 'ball-miss'))
          .join('')}
        <i class="mini-plus">+</i>
        ${back.map((n) => ballHtml(pad2(n), 'blue', actualBack.includes(n) ? 'ball-hit' : 'ball-miss')).join('')}
      </div>
      <div class="mini-compare">开奖：${escapeHtml(draw.groups[0].balls.join(' '))} + ${escapeHtml(
        draw.groups[1].balls.join(' '),
      )}</div>`;
  }

  async function checkNumbers() {
    const picked = collectCheckNumbers();
    if (!picked) return;

    refs.checkBtn.disabled = true;
    refs.checkBtn.textContent = '核对中…';
    try {
      let draw = state.overview?.game;
      if (!draw || draw.stale) {
        const data = await api('/api/draw?issue=latest');
        draw = data.draw;
      }
      renderCheckMini(draw, picked.front, picked.back);
    } catch (error) {
      showToast(error.message || '核对失败，请稍后重试', 'error');
    } finally {
      refs.checkBtn.disabled = false;
      refs.checkBtn.textContent = '核对最新一期';
    }
  }

  async function refreshOverview(manual = false) {
    if (state.refreshing) return;
    state.refreshing = true;
    refs.refreshBtn.classList.add('is-spinning');
    if (manual || !state.overview) setSync('loading', '正在同步');

    const previousIssue = state.overview?.game?.issue;
    try {
      const data = await api(`/api/overview${manual ? '?force=1' : ''}`);
      state.overview = data;
      state.lastRefreshAt = Date.now();
      renderOverviewStats();
      renderHero();
      const clock = formatClock(data.updatedAt);
      if (data.stale) setSync('error', `缓存数据 ${clock}`);
      else setSync('ok', `已同步 ${clock}`);
      if (previousIssue && data.game?.issue && previousIssue !== data.game.issue) {
        loadAnalysis(state.analysisLimit, { force: true, silent: true });
        if (state.history.page === 1 && !state.history.search) loadHistory();
        loadPredictions({ silent: true });
      }
    } catch (error) {
      setSync('error', '同步失败');
      if (manual || !state.overview) showToast(error.message || '同步失败，请稍后重试', 'error');
    } finally {
      state.refreshing = false;
      refs.refreshBtn.classList.remove('is-spinning');
    }
  }

  async function loadAnalysis(limit = state.analysisLimit, { force = false, silent = false } = {}) {
    if (!force && state.analysis?.limit === limit) {
      renderQuickStats();
      if (state.view === 'trend') renderTrend();
      return state.analysis;
    }

    const token = ++state.analysisToken;
    refs.trendUpdated.textContent = '更新中…';
    try {
      const data = await api(`/api/analysis?limit=${limit}`);
      if (token !== state.analysisToken) return state.analysis;
      state.analysis = data;
      state.analysisFetchedAt = new Date();
      renderQuickStats();
      if (state.view === 'trend') renderTrend();
      refs.trendUpdated.textContent = `近 ${limit} 期 · 更新于 ${formatClock(state.analysisFetchedAt)}`;
      return data;
    } catch (error) {
      if (token === state.analysisToken) refs.trendUpdated.textContent = '走势加载失败';
      if (!silent) showToast(error.message || '走势数据加载失败', 'error');
      return state.analysis;
    }
  }

  async function refreshAll(manual = false) {
    await Promise.allSettled([
      refreshOverview(manual),
      loadAnalysis(state.analysisLimit, { force: manual, silent: !manual }),
    ]);
    if (state.history.loaded && state.history.page === 1 && !state.history.search) loadHistory();
    if (!state.prediction.loaded) loadPredictions({ silent: true });
  }

  function renderTrendInsights() {
    if (!state.analysis) return;
    const stats = state.analysis.stats;
    const mainOdd = [...stats.oddEven].sort((a, b) => b.count - a.count)[0];
    const mainBig = [...stats.bigSmall].sort((a, b) => b.count - a.count)[0];
    refs.trendInsights.innerHTML = `
      <div class="insight-card">
        <span class="insight-kicker">前区热号</span>
        <div class="insight-balls">${stats.hotFront
          .slice(0, 3)
          .map((item) => ballHtml(pad2(item.value), 'red', 'sm'))
          .join('')}</div>
        <small>${stats.hotFront
          .slice(0, 3)
          .map((item) => `${pad2(item.value)} · ${item.count}次`)
          .join(' / ')}</small>
      </div>
      <div class="insight-card">
        <span class="insight-kicker">前区冷号</span>
        <div class="insight-balls">${stats.coldFront
          .slice(0, 3)
          .map((item) => ballHtml(pad2(item.value), 'blue', 'sm'))
          .join('')}</div>
        <small>${stats.coldFront
          .slice(0, 3)
          .map((item) => `${pad2(item.value)} · ${item.omission}期`)
          .join(' / ')}</small>
      </div>
      <div class="insight-card">
        <span class="insight-kicker">平均和值 / 跨度</span>
        <strong class="insight-value">${stats.averageSum}</strong>
        <small>平均跨度 ${stats.averageSpan}</small>
      </div>
      <div class="insight-card">
        <span class="insight-kicker">主流结构</span>
        <strong class="insight-value">${mainOdd.label}</strong>
        <small>${mainOdd.label} ${mainOdd.count} 期 · ${mainBig.label} ${mainBig.count} 期</small>
      </div>`;
  }

  function freqChart(items, tone = 'red') {
    const max = Math.max(...items.map((item) => item.count), 1);
    const sorted = [...items].sort((a, b) => b.count - a.count);
    const hotThreshold = sorted[Math.min(4, sorted.length - 1)]?.count || 0;
    return `<div class="chart-scroll"><div class="freq-chart tone-${tone}">${items
      .map((item) => {
        const isHot = item.count >= hotThreshold && hotThreshold > 0;
        return `<div class="freq-col${isHot ? ' is-hot' : ''}" title="${pad2(item.value)} 出现 ${item.count} 次">
          <span class="freq-count">${isHot ? item.count : ''}</span>
          <div class="freq-track"><i style="height:${Math.max(2, (item.count / max) * 100)}%"></i></div>
          <span class="freq-label">${pad2(item.value)}</span>
        </div>`;
      })
      .join('')}</div></div>`;
  }

  function spanChart(spans) {
    if (!spans.length) return '<div class="chart-empty">暂无数据</div>';
    const max = 35;
    const values = spans.map((item) => item.span);
    const average = Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
    const highest = Math.max(...values);
    const lowest = Math.min(...values);
    return `
      <div class="span-chart-scroll">
        <div class="span-chart">
          <span class="span-avg" style="bottom:${(average / max) * 100}%"><i>均值 ${average}</i></span>
          ${spans
            .map(
              (item) => `<div class="span-bar" title="第${item.issue}期 跨度 ${item.span}">
                <i style="height:${Math.max(3, (item.span / max) * 100)}%"></i>
              </div>`,
            )
            .join('')}
        </div>
      </div>
      <div class="span-meta"><span>平均 <b>${average}</b></span><span>最高 <b>${highest}</b></span><span>最低 <b>${lowest}</b></span></div>`;
  }

  function lineChart(stats) {
    const points = stats.sums;
    if (!points.length) return '<div class="chart-empty">暂无数据</div>';
    const w = 880;
    const h = 260;
    const pad = { left: 44, right: 20, top: 22, bottom: 34 };
    const values = points.map((point) => point.sum);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const padValue = Math.max(8, Math.round((rawMax - rawMin) * 0.12));
    const min = Math.max(0, rawMin - padValue);
    const max = Math.min(175, rawMax + padValue);
    const innerW = w - pad.left - pad.right;
    const innerH = h - pad.top - pad.bottom;
    const x = (index) => pad.left + (points.length === 1 ? innerW / 2 : (index / (points.length - 1)) * innerW);
    const y = (value) => pad.top + innerH - ((value - min) / (max - min || 1)) * innerH;
    const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.sum).toFixed(1)}`).join(' ');
    const area = `${line} L${x(points.length - 1).toFixed(1)},${pad.top + innerH} L${x(0).toFixed(1)},${pad.top + innerH} Z`;
    const grid = Array.from({ length: 5 }, (_, index) => {
      const value = min + ((max - min) * index) / 4;
      const yPos = y(value);
      return `<line x1="${pad.left}" y1="${yPos}" x2="${w - pad.right}" y2="${yPos}" class="chart-grid-line" />
        <text x="${pad.left - 9}" y="${yPos + 3}" class="chart-axis-text" text-anchor="end">${Math.round(value)}</text>`;
    }).join('');
    const step = Math.max(1, Math.ceil(points.length / 8));
    const xLabels = points
      .map((point, index) =>
        index % step === 0 || index === points.length - 1
          ? `<text x="${x(index)}" y="${h - 10}" class="chart-axis-text" text-anchor="middle">${point.issue.slice(-4)}</text>`
          : '',
      )
      .join('');
    const dots = points
      .map(
        (point, index) =>
          `<circle cx="${x(index)}" cy="${y(point.sum)}" r="${index === points.length - 1 ? 4.5 : 2.2}" class="chart-dot${
            index === points.length - 1 ? ' is-last' : ''
          }"><title>第${point.issue}期 和值 ${point.sum}</title></circle>`,
      )
      .join('');
    const avgY = y(stats.averageSum);
    return `
      <div class="line-chart-scroll">
        <svg class="line-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="前区和值走势折线图">
          <defs>
            <linearGradient id="sumArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#ff5a4d" stop-opacity="0.28" />
              <stop offset="100%" stop-color="#ff5a4d" stop-opacity="0" />
            </linearGradient>
          </defs>
          ${grid}
          <line x1="${pad.left}" y1="${avgY}" x2="${w - pad.right}" y2="${avgY}" class="chart-avg-line" />
          <text x="${w - pad.right}" y="${avgY - 7}" class="chart-avg-text" text-anchor="end">均值 ${stats.averageSum}</text>
          <path d="${area}" fill="url(#sumArea)" />
          <path d="${line}" class="chart-line" />
          ${dots}
          ${xLabels}
        </svg>
      </div>
      <div class="chart-legend"><span><i class="legend-red"></i>每期和值</span><span><i class="legend-dash"></i>周期均值</span></div>`;
  }

  function donutChart(items, total, tone = 'odd') {
    const colors = ['#ff5a4d', '#ffc857', '#4da3ff', '#40d29f', '#a78bfa', '#f472b6'];
    const active = items.filter((item) => item.count > 0);
    if (!active.length || !total) return '<div class="chart-empty">暂无数据</div>';
    let cursor = 0;
    const stops = active
      .map((item, index) => {
        const start = (cursor / total) * 360;
        cursor += item.count;
        const end = (cursor / total) * 360;
        return `${colors[index % colors.length]} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`;
      })
      .join(', ');
    return `
      <div class="donut-wrap ${tone}">
        <div class="donut" style="background:conic-gradient(${stops})">
          <div class="donut-hole"><strong>${total}</strong><span>期</span></div>
        </div>
        <div class="donut-legend">
          ${active
            .map(
              (item, index) => `<div class="legend-row">
                <i style="background:${colors[index % colors.length]}"></i>
                <span>${escapeHtml(item.label)}</span>
                <b>${item.count}</b>
                <em>${Math.round((item.count / total) * 100)}%</em>
              </div>`,
            )
            .join('')}
        </div>
      </div>`;
  }

  function zoneChart(zones) {
    const total = zones.reduce((sum, zone) => sum + zone.count, 0) || 1;
    const max = Math.max(...zones.map((zone) => zone.count), 1);
    return `<div class="zone-chart">${zones
      .map((zone) => {
        const [name, range] = zone.label.split(' ');
        return `<div class="zone-col">
          <span class="zone-value">${Math.round((zone.count / total) * 100)}%</span>
          <div class="zone-track"><i style="height:${Math.max(4, (zone.count / max) * 100)}%"></i></div>
          <b>${escapeHtml(name)}</b>
          <em>${escapeHtml(range || '')}</em>
        </div>`;
      })
      .join('')}</div>`;
  }

  function omissionChart(stats) {
    const front = [...stats.frontOmission].sort((a, b) => b.omission - a.omission).slice(0, 10);
    const max = Math.max(...front.map((item) => item.omission), 1);
    const backTop = [...stats.backOmission].sort((a, b) => b.omission - a.omission).slice(0, 3);
    return `
      <div class="omit-list">
        ${front
          .map(
            (item) => `<div class="omit-row">
              <span class="omit-num">${pad2(item.value)}</span>
              <div class="omit-track"><i style="width:${Math.max(3, (item.omission / max) * 100)}%"></i></div>
              <b>${item.omission} 期</b>
            </div>`,
          )
          .join('')}
      </div>
      <div class="omit-back">后区遗漏：${backTop
        .map((item) => `${pad2(item.value)}（${item.omission}期）`)
        .join(' · ')}</div>`;
  }

  function matrixChart(draws) {
    if (!draws.length) return '<div class="chart-empty">暂无数据</div>';
    const rows = draws.slice(0, 30);
    const frontNumbers = Array.from({ length: 35 }, (_, i) => i + 1);
    const backNumbers = Array.from({ length: 12 }, (_, i) => i + 1);
    return `
      <div class="matrix-scroll">
        <table class="trend-matrix">
          <thead>
            <tr>
              <th class="matrix-issue">期号</th>
              ${frontNumbers.map((n) => `<th class="matrix-front">${pad2(n)}</th>`).join('')}
              ${backNumbers
                .map((n, index) => `<th class="matrix-back${index === 0 ? ' back-start' : ''}">${pad2(n)}</th>`)
                .join('')}
            </tr>
          </thead>
          <tbody>
            ${rows
              .map((draw, index) => {
                const front = new Set(draw.groups[0].balls.map(Number));
                const back = new Set(draw.groups[1].balls.map(Number));
                return `<tr class="${index === 0 ? 'is-latest' : ''}">
                  <td class="matrix-issue">${escapeHtml(draw.issue)}</td>
                  ${frontNumbers
                    .map(
                      (n) =>
                        `<td class="m-cell matrix-front${front.has(n) ? ' has' : ''}" title="${draw.issue} 前区 ${pad2(
                          n,
                        )}"><i></i></td>`,
                    )
                    .join('')}
                  ${backNumbers
                    .map(
                      (n, index) =>
                        `<td class="m-cell matrix-back${index === 0 ? ' back-start' : ''}${
                          back.has(n) ? ' has' : ''
                        }" title="${draw.issue} 后区 ${pad2(n)}"><i></i></td>`,
                    )
                    .join('')}
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="chart-legend matrix-legend"><span><i class="legend-red"></i>前区开出</span><span><i class="legend-blue"></i>后区开出</span><span>横向可滑动查看全部号码</span></div>`;
  }

  function renderTrend() {
    if (!state.analysis) return;
    const stats = state.analysis.stats;
    renderTrendInsights();
    refs.chartFrontFreq.innerHTML = freqChart(stats.frontFreq, 'red');
    refs.chartBackFreq.innerHTML = freqChart(stats.backFreq, 'blue');
    refs.chartSpan.innerHTML = spanChart(stats.spans);
    refs.chartSum.innerHTML = lineChart(stats);
    refs.sumBadge.textContent = `均值 ${stats.averageSum}`;
    refs.chartOdd.innerHTML = donutChart(stats.oddEven, stats.total, 'odd');
    refs.chartBig.innerHTML = donutChart(stats.bigSmall, stats.total, 'big');
    refs.chartZone.innerHTML = zoneChart(stats.zones);
    refs.chartOmission.innerHTML = omissionChart(stats);
    refs.chartMatrix.innerHTML = matrixChart(state.analysis.draws);
    refs.trendUpdated.textContent = `近 ${state.analysis.limit} 期 · 更新于 ${formatClock(state.analysisFetchedAt)}`;
  }

  function selectedMethods() {
    return $$('#methodList input:checked').map((input) => input.value);
  }

  function cryptoRandom() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const buffer = new Uint32Array(1);
      crypto.getRandomValues(buffer);
      return buffer[0] / 2 ** 32;
    }
    return Math.random();
  }

  function mulberry32(seed) {
    let value = seed >>> 0;
    return function random() {
      value += 0x6d2b79f5;
      let t = value;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function sampleUniform(random, min, max, count) {
    const pool = [];
    for (let n = min; n <= max; n += 1) pool.push(n);
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count).sort((a, b) => a - b);
  }

  function weightedSample(items, count, weightFn, random) {
    const pool = items.map((item) => ({
      value: item.value,
      weight: Math.max(0.0001, weightFn(item) * (0.65 + random() * 0.7)),
    }));
    const picked = [];
    while (picked.length < count && pool.length) {
      const total = pool.reduce((sum, item) => sum + item.weight, 0);
      let threshold = random() * total;
      let index = 0;
      for (; index < pool.length; index += 1) {
        threshold -= pool[index].weight;
        if (threshold <= 0) break;
      }
      index = Math.min(index, pool.length - 1);
      picked.push(pool[index].value);
      pool.splice(index, 1);
    }
    return picked.sort((a, b) => a - b);
  }

  function isPlausible(front) {
    const sum = front.reduce((total, n) => total + n, 0);
    const odd = front.filter((n) => n % 2 === 1).length;
    const big = front.filter((n) => n >= 18).length;
    return sum >= 45 && sum <= 145 && odd >= 1 && odd <= 4 && big >= 1 && big <= 4;
  }

  /* ============================================================
     多维预测引擎：AI 集成 / 宇宙通识常量 / 混沌动力学 / 马尔可夫链
     全部在本机计算，不依赖外部服务。维度分数都归一化到 0~1，
     供加权采样使用；isPlausible 兜底保证形态合理。
     ============================================================ */

  // 宇宙通识常量库：圆周率、自然常数、黄金分割、√2、精细结构常数、
  // 光速、普朗克常数、阿伏伽德罗常数、万有引力常数、玻尔兹曼常数、元电荷
  const UNIVERSAL_CONSTANTS = [
    { name: 'π', digits: '31415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679821480865132823066470938446095505822317253594081284811174502841027019385211055596446229489549303819644288109756659334461284756482337867831652712019091456485669234603345' },
    { name: 'e', digits: '27182818284590452353602874713526624977572470936999595749669676277240766303535475945713821785251664274274663919320030599218174135966290435729003342952605956307381323286279434907632338298807531952510190115738341879307021540891499348841675092447614606680822' },
    { name: 'φ', digits: '16180339887498948482045868343656381177203091798057628621354486227052604628189024497072072041893911374847540880753868917521266338622235369317931800607667263544333890865959395829056383226613199282902678806752087668925017116962070322104321626954862629631361' },
    { name: '√2', digits: '14142135623730950488016887242096980785696718753769480731766797387994835492414813996884313426642979858232728143692231652528892314850830767879082305568142479454107856328463227345719974496247548182435825964300946204775475891489319501379864211264877795714969' },
    { name: 'α⁻¹', digits: '137035999084' },
    { name: 'c', digits: '299792458' },
    { name: 'h', digits: '662607015' },
    { name: 'Nₐ', digits: '602214076' },
    { name: 'G', digits: '667430' },
    { name: 'k_B', digits: '1380649' },
    { name: 'qₑ', digits: '1602176634' },
  ];
  const FIB_SET = new Set([1, 2, 3, 5, 8, 13, 21, 34]);
  const PRIME_SET = new Set([2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31]);

  function constantScoreFor(range, offsetBase, salt) {
    // 每个号码从 11 个常量里各取一位数字（位置随期号/盐值偏移），平均后归一化
    const scores = [];
    for (let n = 1; n <= range; n += 1) {
      let total = 0;
      for (let c = 0; c < UNIVERSAL_CONSTANTS.length; c += 1) {
        const stream = UNIVERSAL_CONSTANTS[c].digits;
        const pos = (offsetBase + n * 7 + c * 13 + salt * 29) % stream.length;
        total += Number(stream[pos]) / 9;
      }
      scores.push({ value: n, score: total / UNIVERSAL_CONSTANTS.length });
    }
    return scores;
  }

  function chaosScoreFor(range, x0, r) {
    // logistic map：x(n+1) = r·x(n)·(1-x(n))，用轨迹落桶频率当权重
    let x = x0;
    if (!Number.isFinite(x) || x <= 0 || x >= 1) x = 0.6180339887;
    const buckets = new Map();
    for (let i = 0; i < 720; i += 1) {
      x = r * x * (1 - x);
      if (x <= 0 || x >= 1 || !Number.isFinite(x)) {
        x = (x * 7919 + 0.123456) % 1;
        if (x <= 0) x = 0.4142135623;
      }
      const v = Math.min(range, 1 + Math.floor(x * range));
      buckets.set(v, (buckets.get(v) || 0) + 1);
    }
    const maxCount = Math.max(...buckets.values());
    const scores = [];
    for (let n = 1; n <= range; n += 1) {
      scores.push({ value: n, score: (buckets.get(n) || 0) / maxCount });
    }
    return scores;
  }

  function markovTransitions() {
    // 相邻两期的号码转移频率：上一期开了 n → 下一期出现 m 的次数
    const draws = state.analysis?.draws || [];
    const front = new Map();
    const back = new Map();
    for (let i = draws.length - 1; i > 0; i -= 1) {
      const prevF = draws[i].groups[0].balls.map(Number);
      const nextF = draws[i - 1].groups[0].balls.map(Number);
      for (const p of prevF) {
        for (const m of nextF) {
          if (!front.has(p)) front.set(p, new Map());
          const row = front.get(p);
          row.set(m, (row.get(m) || 0) + 1);
        }
      }
      const prevB = draws[i].groups[1].balls.map(Number);
      const nextB = draws[i - 1].groups[1].balls.map(Number);
      for (const p of prevB) {
        for (const m of nextB) {
          if (!back.has(p)) back.set(p, new Map());
          const row = back.get(p);
          row.set(m, (row.get(m) || 0) + 1);
        }
      }
    }
    return { front, back };
  }

  function normalizeScores(scores) {
    const max = Math.max(...scores.map((item) => item.score)) || 1;
    return scores.map((item) => ({ value: item.value, score: item.score / max }));
  }

  function latestDrawNumbers() {
    const draw = state.analysis?.draws?.[0];
    if (!draw) return { front: [], back: [] };
    return {
      front: draw.groups[0].balls.map(Number),
      back: draw.groups[1].balls.map(Number),
    };
  }

  // AI 集成：7 个前区维度 + 5 个后区维度，加权合成一张「号码势能表」
  function buildAIDimensions(context) {
    const stats = state.analysis.stats;
    const last = latestDrawNumbers();
    const issueBase = Number(context.issue) || Number(stats.latestIssue) || 0;
    const salt = (hashString(`${context.birthday}|${context.seed}|${context.nonce}|${context.index}`) % 9973) + 1;
    const x0 =
      ((last.front.reduce((total, n) => total + n, 0) + issueBase * 7 + context.index * 3) % 1000) /
        1000 +
      0.05;

    const recent = new Map();
    for (const draw of state.analysis.draws.slice(0, 10)) {
      for (const n of draw.groups[0].balls.map(Number)) recent.set(n, (recent.get(n) || 0) + 1);
    }

    const { front: transF } = markovTransitions();
    const markovScore = [];
    for (let n = 1; n <= 35; n += 1) {
      let total = 0;
      for (const p of last.front) total += transF.get(p)?.get(n) || 0;
      markovScore.push({ value: n, score: total });
    }

    const neighborScore = [];
    for (let n = 1; n <= 35; n += 1) {
      let total = 0;
      for (const p of last.front) {
        const gap = Math.abs(n - p);
        if (gap === 1) total += 1;
        else if (gap === 2) total += 0.45;
      }
      neighborScore.push({ value: n, score: total });
    }

    const cosmosScore = constantScoreFor(35, issueBase * 11, salt);

    const dimsFront = {
      '近10期热度': normalizeScores(
        Array.from({ length: 35 }, (_, i) => ({ value: i + 1, score: recent.get(i + 1) || 0 })),
      ),
      '马尔可夫转移': normalizeScores(markovScore),
      '邻号引力': normalizeScores(neighborScore),
      '混沌轨迹': normalizeScores(chaosScoreFor(35, x0, 3.987)),
      '宇宙常量': normalizeScores(cosmosScore),
    };

    const { back: transB } = markovTransitions();
    const backMarkov = [];
    for (let n = 1; n <= 12; n += 1) {
      let total = 0;
      for (const p of last.back) total += transB.get(p)?.get(n) || 0;
      backMarkov.push({ value: n, score: total });
    }

    const dimsBack = {
      '马尔可夫转移': normalizeScores(backMarkov),
      '混沌轨迹': normalizeScores(chaosScoreFor(12, x0 * 1.618, 3.923)),
      '宇宙常量': normalizeScores(constantScoreFor(12, issueBase * 17, salt)),
    };

    return { dimsFront, dimsBack, cosmosScore, issueBase, salt };
  }

  function combineDims(dims, weights, random) {
    const values = Object.keys(dims)[0] !== undefined ? dims[Object.keys(dims)[0]] : [];
    return values.map(({ value }) => {
      let total = 0;
      for (const [name, weight] of Object.entries(weights)) {
        const hit = dims[name].find((item) => item.value === value);
        total += weight * (hit ? hit.score : 0);
      }
      return { value, score: total * (0.72 + random() * 0.56) };
    });
  }

  function topDimLabels(dims, weights, count = 3) {
    return Object.entries(weights)
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([name]) => name);
  }

  function buildCandidate(method, context) {
    const { birthday, seed, now, index, nonce } = context;
    let front = [];
    let back = [];

    if (method === 'birthday') {
      const random = mulberry32(
        hashString(`${birthday || 'today'}|${formatDateTime(now)}|${seed}|${index}|${nonce}`),
      );
      for (let attempt = 0; attempt < 60; attempt += 1) {
        front = sampleUniform(random, 1, 35, 5);
        back = sampleUniform(random, 1, 12, 2);
        if (isPlausible(front)) return { front, back };
      }
      return { front, back };
    }

    if (method === 'ai') {
      const { dimsFront, dimsBack } = buildAIDimensions(context);
      const weightsFront = {
        近10期热度: 0.24,
        马尔可夫转移: 0.24,
        邻号引力: 0.12,
        混沌轨迹: 0.18,
        宇宙常量: 0.22,
      };
      const weightsBack = { 马尔可夫转移: 0.38, 混沌轨迹: 0.28, 宇宙常量: 0.34 };
      const combinedFront = combineDims(dimsFront, weightsFront, Math.random);
      const combinedBack = combineDims(dimsBack, weightsBack, Math.random);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        front = weightedSample(combinedFront, 5, (item) => 1 + item.score * 6, Math.random);
        back = weightedSample(combinedBack, 2, (item) => 1 + item.score * 6, Math.random);
        if (isPlausible(front) && back.length === 2) {
          return { front, back, dims: { dimsFront, dimsBack, weightsFront } };
        }
      }
      return { front, back, dims: { dimsFront, dimsBack, weightsFront } };
    }

    if (method === 'cosmos') {
      const issueBase = Number(context.issue) || Number(state.analysis.stats.latestIssue) || 0;
      const salt = (hashString(`${context.seed}|${context.nonce}|${index}`) % 7919) + 1;
      const offsetBase = (issueBase * 11 + salt * 7) % 200;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const cosmicFront = constantScoreFor(35, offsetBase + attempt * 3, salt).map((item) => {
          let score = item.score;
          if (FIB_SET.has(item.value)) score *= 1.618; // 黄金分割眷顾斐波那契数
          if (PRIME_SET.has(item.value)) score *= 1.375; // 精细结构常数眷顾素数
          return { value: item.value, score };
        });
        const cosmicBack = constantScoreFor(12, offsetBase + attempt * 3 + 5, salt);
        front = weightedSample(cosmicFront, 5, (item) => 0.4 + item.score * 4.5, Math.random);
        back = weightedSample(cosmicBack, 2, (item) => 0.4 + item.score * 4.5, Math.random);
        if (isPlausible(front) && back.length === 2) {
          const used = [...new Set([...front, ...back])].map(pad2).join('、');
          return {
            front,
            back,
            cosmos: { names: UNIVERSAL_CONSTANTS.map((item) => item.name), offset: offsetBase, salt, used },
          };
        }
      }
      return { front, back };
    }

    if (method === 'chaos') {
      const last = latestDrawNumbers();
      const issueBase = Number(context.issue) || Number(state.analysis.stats.latestIssue) || 0;
      const x0 =
        (((last.front.reduce((total, n) => total + n, 37) * (1 + index) + issueBase * 13) % 997) + 7) / 1007;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const chaosFront = chaosScoreFor(35, x0 + attempt * 0.013, 3.9 + (attempt % 10) * 0.01);
        const chaosBack = chaosScoreFor(12, x0 * 1.414 + attempt * 0.017, 3.85);
        front = weightedSample(chaosFront, 5, (item) => 0.3 + item.score * 5, Math.random);
        back = weightedSample(chaosBack, 2, (item) => 0.3 + item.score * 5, Math.random);
        if (isPlausible(front) && back.length === 2) {
          return {
            front,
            back,
            chaos: { x0: x0.toFixed(4), r: '3.9x', source: last.front.length ? last.front.map(pad2).join(' ') : '期号' },
          };
        }
      }
      return { front, back };
    }

    if (method === 'markov') {
      const { front: transF, back: transB } = markovTransitions();
      const last = latestDrawNumbers();
      if (!last.front.length) {
        // 没有历史数据时退化为随机
        for (let attempt = 0; attempt < 60; attempt += 1) {
          front = sampleUniform(cryptoRandom, 1, 35, 5);
          back = sampleUniform(cryptoRandom, 1, 12, 2);
          if (isPlausible(front)) return { front, back };
        }
        return { front, back };
      }
      const markovFront = [];
      for (let n = 1; n <= 35; n += 1) {
        let total = 0;
        for (const p of last.front) total += transF.get(p)?.get(n) || 0;
        markovFront.push({ value: n, score: total });
      }
      const markovBack = [];
      for (let n = 1; n <= 12; n += 1) {
        let total = 0;
        for (const p of last.back) total += transB.get(p)?.get(n) || 0;
        markovBack.push({ value: n, score: total });
      }
      for (let attempt = 0; attempt < 60; attempt += 1) {
        front = weightedSample(markovFront, 5, (item) => 1 + item.score * 1.6, Math.random);
        back = weightedSample(markovBack, 2, (item) => 1 + item.score * 1.6, Math.random);
        if (isPlausible(front) && back.length === 2) {
          const strong = [...markovFront]
            .sort((a, b) => b.score - a.score || a.value - b.value)
            .slice(0, 3)
            .filter((item) => item.score > 0)
            .map((item) => pad2(item.value))
            .join('、');
          return { front, back, markov: { strong } };
        }
      }
      return { front, back };
    }

    for (let attempt = 0; attempt < 60; attempt += 1) {
      front = sampleUniform(cryptoRandom, 1, 35, 5);
      back = sampleUniform(cryptoRandom, 1, 12, 2);
      if (isPlausible(front)) return { front, back };
    }
    return { front, back };
  }

  function methodReason(method, context, candidate = null) {
    if (method === 'birthday') {
      const birthdayLabel = context.birthday ? `生日 ${context.birthday}` : '生日未填';
      return `${birthdayLabel} · 今日时间 ${formatDateTime(context.now)}`;
    }
    if (method === 'ai' && candidate?.dims) {
      const topDims = topDimLabels(candidate.dims.dimsFront, candidate.dims.weightsFront, 3);
      const leaders = Object.values(candidate.dims.dimsFront)
        .reduce((acc, dim) => {
          dim.forEach(({ value, score }, i) => {
            acc[i] = (acc[i] || 0) + score;
          });
          return acc;
        }, [])
        .map((total, i) => ({ value: i + 1, score: total }))
        .sort((a, b) => b.score - a.score || a.value - b.value)
        .slice(0, 3)
        .map((item) => pad2(item.value))
        .join('、');
      return `AI 五维加权集成（${topDims.join(' / ')} 为本次主导维度）· 全维势能最高号码 ${leaders} · 第 ${context.index + 1} 组扰动采样`;
    }
    if (method === 'cosmos' && candidate?.cosmos) {
      const { names, offset, salt, used } = candidate.cosmos;
      return `映射 ${names.join(' ')} 共 11 个宇宙通识常量的数字流（偏移 ${offset} · 盐 ${salt}），斐波那契数 ×φ、素数 ×α⁻¹ 加权 · 常量能量落于 ${used}`;
    }
    if (method === 'chaos' && candidate?.chaos) {
      const { x0, r, source } = candidate.chaos;
      return `logistic 映射 x→${r}x(1-x)，初值 x₀=${x0} 由上期号码「${source}」与期号耦合，720 步轨迹落桶频率采样`;
    }
    if (method === 'markov' && candidate?.markov) {
      const last = latestDrawNumbers();
      const lastText = last.front.length ? last.front.map(pad2).join(' ') : '—';
      return `统计近${state.analysis.limit}期相邻两期的号码转移矩阵，由上期前区 ${lastText} 出发，转移概率最高：${candidate.markov.strong || '分布均匀'}`;
    }
    return `实时随机种子 · ${formatDateTime(context.now)}`;
  }

  /* ---------- 预测批次：存档 / 开奖结算 ---------- */

  function currentBatch() {
    const prediction = state.prediction;
    return prediction.activeBatch || prediction.batches[0] || null;
  }

  function applyPredictionState(data) {
    const prediction = state.prediction;
    prediction.activeBatch = data?.activeBatch || null;
    prediction.batches = Array.isArray(data?.batches) ? data.batches : [];
    prediction.latestIssue = data?.latestIssue || null;
    prediction.nextIssue = data?.nextIssue || null;
    prediction.nextDrawAt = data?.nextDrawAt || null;
    prediction.loaded = true;

    const batch = currentBatch();
    prediction.results = batch?.results || [];
    prediction.generatedAt = batch?.createdAt ? new Date(batch.createdAt) : null;
    prediction.methods = batch?.methods || [];
    prediction.analysisLimit = batch?.analysisLimit || state.analysisLimit;
    prediction.currentBatch = batch;
  }

  async function loadPredictions({ silent = false } = {}) {
    try {
      const data = await api('/api/predictions');
      applyPredictionState(data);
      renderPredictStatus();
      renderPredictions();
      renderPredictHistory();
      syncGenerateButton();
      return data;
    } catch (error) {
      if (!silent) showToast(error.message || '预测记录加载失败', 'error');
      return null;
    }
  }

  /* ============================================================
     生日记忆：在「你的生日」输入框下方显示上一次输入的日期
     存储分两层：服务端 data/user-settings.json（主）+ localStorage（即时 / 降级）。
     显示的是「本次打开页面之前」保存的那一次；本次修改只写存储、不改写显示，
     这样「上一次」的语义才成立，下次打开页面自然更新。
     ============================================================ */
  const BIRTHDAY_STORE_KEY = 'dlt:lastBirthday';
  const BIRTHDAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  let birthdayMemoryRecord = null; // { value, updatedAt } —— 仅用于展示
  let birthdaySaveTimer = null;
  let birthdaySaveToken = 0;

  function validBirthday(value) {
    if (!BIRTHDAY_RE.test(String(value || ''))) return false;
    const [y, m, d] = String(value).split('-').map(Number);
    const at = new Date(Date.UTC(y, m - 1, d));
    if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return false;
    if (y < 1900 || y > new Date().getUTCFullYear() + 1) return false;
    return String(value) <= formatToday();
  }

  function readLocalBirthday() {
    try {
      const raw = window.localStorage.getItem(BIRTHDAY_STORE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return validBirthday(data?.value)
        ? { value: data.value, updatedAt: data.updatedAt || null }
        : null;
    } catch {
      return null; // 隐私模式 / 存储被禁用
    }
  }

  function writeLocalBirthday(record) {
    try {
      if (record && validBirthday(record.value)) {
        window.localStorage.setItem(BIRTHDAY_STORE_KEY, JSON.stringify(record));
      } else {
        window.localStorage.removeItem(BIRTHDAY_STORE_KEY);
      }
    } catch {
      // localStorage 不可用时静默降级，服务端存储仍可工作
    }
  }

  function formatBirthdayMoment(iso) {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(at)
      .replace(/\//g, '-');
  }

  function renderBirthdayMemory() {
    if (!refs.birthdayMemory) return;
    const record = birthdayMemoryRecord;
    const has = Boolean(record && validBirthday(record.value));
    refs.birthdayMemoryEmpty.hidden = has;
    refs.birthdayMemoryValue.hidden = !has;
    refs.birthdayMemoryTime.hidden = !has;
    refs.birthdayMemoryFill.hidden = !has;
    if (!has) return;
    refs.birthdayMemoryValue.textContent = record.value;
    const moment = record.updatedAt ? formatBirthdayMoment(record.updatedAt) : '';
    refs.birthdayMemoryTime.textContent = moment ? `· ${moment}` : '';
    refs.birthdayMemoryTime.hidden = !moment;
    refs.birthdayMemoryFill.dataset.value = record.value;
  }

  async function loadBirthdayMemory() {
    // 先渲染本地值，保证首屏不闪；再拉服务端值，取两者中较新的一条
    birthdayMemoryRecord = readLocalBirthday();
    renderBirthdayMemory();
    try {
      const data = await api('/api/settings');
      const remote = validBirthday(data?.lastBirthday)
        ? { value: data.lastBirthday, updatedAt: data.updatedAt || null }
        : null;
      const local = birthdayMemoryRecord;
      const localAt = local?.updatedAt ? Date.parse(local.updatedAt) || 0 : 0;
      const remoteAt = remote?.updatedAt ? Date.parse(remote.updatedAt) || 0 : 0;
      if (remote && remoteAt >= localAt) birthdayMemoryRecord = remote;
      else if (!local && !remote) birthdayMemoryRecord = null;
      writeLocalBirthday(birthdayMemoryRecord);
      renderBirthdayMemory();
    } catch {
      // 接口不可用（如旧版服务未重启）时保留本地值，不影响预测功能
    }
  }

  function rememberBirthday(value) {
    const next = String(value || '').trim();
    if (!validBirthday(next)) return; // 清空或非法值不覆盖历史记录
    const record = { value: next, updatedAt: new Date().toISOString() };
    writeLocalBirthday(record); // 本地立即落盘，断网也能记住
    window.clearTimeout(birthdaySaveTimer);
    const token = ++birthdaySaveToken;
    birthdaySaveTimer = window.setTimeout(async () => {
      try {
        await apiPost('/api/settings', { lastBirthday: next });
      } catch {
        if (token === birthdaySaveToken) {
          // 服务端写入失败时本地记录仍然有效，静默降级
        }
      }
    }, 300);
  }

  function fillBirthdayMemory() {
    const value = refs.birthdayMemoryFill?.dataset.value;
    if (!validBirthday(value) || !refs.birthdayInput) return;
    refs.birthdayInput.value = value;
    showToast('已填入上次输入的生日');
  }

  function syncGenerateButton() {
    const prediction = state.prediction;
    const locked = Boolean(prediction.activeBatch);
    refs.generateBtn.disabled = locked || prediction.busy;
    refs.generateBtn.classList.toggle('is-locked', locked);
    refs.generateBtn.innerHTML = locked
      ? '本期号码已存档 · 等待开奖'
      : '生成下期号码 <span>→</span>';
  }

  function formatDrawMoment(iso) {
    if (!iso) return '以官方公告为准';
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '以官方公告为准';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
  }

  function renderPredictStatus() {
    const batch = currentBatch();
    if (!batch) {
      refs.predictStatus.hidden = true;
      refs.predictStatus.innerHTML = '';
      return;
    }
    refs.predictStatus.hidden = false;

    if (batch.status === 'pending') {
      refs.predictStatus.className = 'predict-status is-pending';
      refs.predictStatus.innerHTML = `
        <span class="status-icon">◷</span>
        <div class="status-copy">
          <strong>第 ${escapeHtml(batch.targetIssue)} 期号码已存档</strong>
          <p>本期号码已锁定并写入本地存档，不再变动。开奖后会自动核对命中号码与中奖等级。</p>
        </div>
        <div class="status-meta">
          <span>预计开奖</span>
          <b>${escapeHtml(formatDrawMoment(batch.targetDrawAt || state.prediction.nextDrawAt))}</b>
        </div>`;
      return;
    }

    const draw = batch.draw || {};
    const won = batch.winCount > 0;
    refs.predictStatus.className = `predict-status ${won ? 'is-win' : 'is-lose'}`;
    refs.predictStatus.innerHTML = `
      <span class="status-icon">${won ? '★' : '✓'}</span>
      <div class="status-copy">
        <strong>第 ${escapeHtml(batch.targetIssue)} 期已开奖 · ${
          won ? `命中 ${batch.winCount} 组，最高 ${escapeHtml(batch.bestTier)}` : '本期未中奖'
        }</strong>
        <p>开奖号码　${escapeHtml(draw.resultText || '—')}${
          won ? '　·　单注奖金以官方公告为准，未区分追加投注' : '　·　继续观察下一期'
        }</p>
      </div>
      <div class="status-meta">
        <span>开奖日期</span>
        <b>${escapeHtml(draw.drawDate || '—')}</b>
      </div>`;
  }

  function renderPredictions() {
    const batch = currentBatch();
    const results = state.prediction.results;

    if (!results.length) {
      refs.predictResults.innerHTML = `
        <div class="predict-placeholder">
          <span class="placeholder-orbit"><span></span><span></span><span></span></span>
          <strong>还没有生成号码</strong>
          <p>设置生日和策略，点击「生成下期号码」。生成后这一批号码会被保存，开奖后自动核对中奖情况。</p>
        </div>`;
      refs.predictSummary.textContent = '等待生成';
      return;
    }

    const settled = batch?.status === 'settled';
    const labels = [...new Set(results.map((result) => METHODS[result.method]?.label || '号码'))];
    refs.predictSummary.textContent = settled
      ? `第 ${batch.targetIssue} 期 · ${results.length} 组 · 已开奖结算`
      : `第 ${batch.targetIssue} 期 · 已存档 ${results.length} 组 · 近 ${state.prediction.analysisLimit} 期 · ${labels.join(
          ' / ',
        )}`;

    refs.predictResults.innerHTML = results
      .map((result, index) => {
        const method = METHODS[result.method] || METHODS.random;
        const frontHtml = result.front
          .map((n, i) => {
            const hit = settled ? result.frontHitFlags?.[i] : false;
            return ballHtml(pad2(n), 'red', settled ? (hit ? 'sm ball-hit' : 'sm ball-miss') : 'sm');
          })
          .join('');
        const backHtml = result.back
          .map((n, i) => {
            const hit = settled ? result.backHitFlags?.[i] : false;
            return ballHtml(pad2(n), 'blue', settled ? (hit ? 'sm ball-hit' : 'sm ball-miss') : 'sm');
          })
          .join('');

        const resultLine = settled
          ? result.tier
            ? `<div class="pred-result is-win"><b>${escapeHtml(result.tier)}</b><span>前区 ${result.frontHits} · 后区 ${result.backHits}${
                result.prizeAmount ? ` · 单注约 ${formatExactCny(result.prizeAmount)}` : ''
              }</span></div>`
            : `<div class="pred-result is-lose"><b>未中奖</b><span>前区 ${result.frontHits} · 后区 ${result.backHits}</span></div>`
          : '';

        return `<article class="prediction-card method-${method.color}" style="--i:${index}">
          <div class="pred-top">
            <span class="pred-tag tag-${method.color}">${method.label}</span>
            <span class="pred-index">${String(index + 1).padStart(2, '0')}</span>
          </div>
          <div class="pred-numbers">
            <div class="pred-row"><span>前区</span><div class="balls">${frontHtml}</div></div>
            <div class="pred-row"><span>后区</span><div class="balls">${backHtml}</div></div>
          </div>
          <div class="pred-features">
            <span>和值 <b>${result.features?.sum ?? '—'}</b></span>
            <span>${escapeHtml(result.features?.structure || '')}</span>
            <span>跨度 <b>${result.features?.span ?? '—'}</b></span>
          </div>
          ${resultLine}
          <p class="pred-reason">${escapeHtml(result.reason || '')}</p>
          <button class="text-btn" type="button" data-copy-index="${index}">复制这组</button>
        </article>`;
      })
      .join('');
  }

  function renderPredictHistory() {
    const batches = state.prediction.batches;
    if (!batches.length) {
      refs.predictHistory.innerHTML = '<div class="history-empty-note">还没有已保存的预测批次。</div>';
      return;
    }

    const rows = batches
      .slice(0, 12)
      .map((batch) => {
        const settled = batch.status === 'settled';
        const won = settled && batch.winCount > 0;
        const statusHtml = settled
          ? won
            ? `<span class="pill is-win">${escapeHtml(batch.bestTier)}</span>`
            : '<span class="pill is-lose">未中奖</span>'
          : '<span class="pill is-pending">待开奖</span>';
        return `<tr data-open-batch="${escapeHtml(batch.id)}">
          <td><b>${escapeHtml(batch.targetIssue)}</b></td>
          <td>${escapeHtml(formatDrawMoment(batch.createdAt))}</td>
          <td>${batch.results.length} 组</td>
          <td>${settled ? `${batch.winCount} 组命中` : '—'}</td>
          <td>${statusHtml}</td>
        </tr>`;
      })
      .join('');

    refs.predictHistory.innerHTML = `
      <div class="table-wrap">
        <table class="history-table predict-history-table">
          <thead><tr><th>目标期号</th><th>生成时间</th><th>组数</th><th>命中</th><th>结果</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="predict-history-note">存档保存在本机 <code>data/predictions.json</code>，开奖后自动结算；只保留最近 60 期。</p>`;
  }

  async function generatePredictions() {
    if (state.prediction.busy) return;
    if (state.prediction.activeBatch) {
      showToast('本期号码已存档，开奖后才能生成新一期', 'error');
      return;
    }

    const methods = selectedMethods();
    if (!methods.length) {
      showToast('请至少选择一种预测策略', 'error');
      return;
    }

    state.prediction.busy = true;
    refs.generateBtn.disabled = true;
    refs.generateBtn.textContent = '正在生成…';
    try {
      if (!state.analysis) {
        await loadAnalysis(state.analysisLimit, { silent: true });
      }
      if (!state.analysis) {
        showToast('走势数据还未加载完成，请稍后重试', 'error');
        return;
      }
      if (!state.prediction.loaded) {
        await loadPredictions({ silent: true });
      }

      const baseIssue = state.prediction.latestIssue || state.overview?.game?.issue;
      const targetIssue = state.prediction.nextIssue;
      if (!baseIssue || !targetIssue) {
        showToast('暂未获取到下一期期号，请稍后重试', 'error');
        return;
      }

      const birthday = refs.birthdayInput.value;
      const seed = '';
      rememberBirthday(birthday); // 生成时补存一次，兼容非 change 途径填值
      const now = new Date();
      state.prediction.nonce += 1;
      const context = { birthday, seed, now, nonce: state.prediction.nonce, issue: targetIssue };
      const results = [];
      const seen = new Set();

      for (let index = 0; index < PICK_COUNT; index += 1) {
        const method = methods[index % methods.length];
        let candidate = null;
        let attempts = 0;
        while (attempts < 80) {
          candidate = buildCandidate(method, { ...context, index });
          const key = `${candidate.front.join(',')}-${candidate.back.join(',')}`;
          if (!seen.has(key)) {
            seen.add(key);
            break;
          }
          attempts += 1;
        }
        const finalCandidate = candidate || buildCandidate(method, { ...context, index });
        results.push({
          ...finalCandidate,
          method,
          features: computeFeatures(finalCandidate.front, finalCandidate.back),
          reason: methodReason(method, context, finalCandidate),
        });
      }

      const data = await apiPost('/api/predictions', {
        baseIssue,
        targetIssue,
        targetDrawAt: state.prediction.nextDrawAt,
        methods,
        birthday,
        seed,
        analysisLimit: state.analysis.limit,
        results,
      });

      applyPredictionState(data);
      renderPredictStatus();
      renderPredictions();
      renderPredictHistory();
      updateLiveClock();
      showToast(`第 ${targetIssue} 期号码已存档，等待开奖`);
    } catch (error) {
      showToast(error.message || '生成失败，请稍后重试', 'error');
    } finally {
      state.prediction.busy = false;
      syncGenerateButton();
    }
  }

  function updateLiveClock() {
    if (!refs.predictTime) return;
    const now = new Date();
    refs.predictTime.textContent = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(now);
  }

  function prizeTableHtml(draw) {
    if (!draw.prizeLevels?.length) return '';
    return `
      <div class="detail-section">
        <h3>奖级明细 <small>单注奖金 / 中奖注数</small></h3>
        <div class="match-scroll">
          <table class="prize-table">
            <thead><tr><th>奖级</th><th>中奖注数</th><th>单注奖金</th><th>总奖金</th></tr></thead>
            <tbody>
              ${draw.prizeLevels
                .map(
                  (prize) => `<tr>
                    <td>${escapeHtml(prize.name)}</td>
                    <td>${prize.winners === 0 ? '0' : formatNum(prize.winners)}</td>
                    <td class="prize-amount">${formatExactCny(prize.amount)}</td>
                    <td class="prize-amount">${formatExactCny(prize.total)}</td>
                  </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function openDetail(draw) {
    const front = draw.groups[0].balls.map(Number);
    const back = draw.groups[1].balls.map(Number);
    const features = computeFeatures(front, back);
    refs.dialogBody.innerHTML = `
      <div class="detail-hero" style="--accent:${escapeHtml(draw.accent)}">
        <div class="detail-topline"><span>超级大乐透</span><span>第 ${escapeHtml(draw.issue)} 期 · 官方数据</span></div>
        <div class="detail-heading">
          <div>
            <span class="detail-issue">${escapeHtml(draw.drawDate)} 开奖</span>
            <h2>第 ${escapeHtml(draw.issue)} 期</h2>
            <p>前区 5 个号码（01-35）+ 后区 2 个号码（01-12）</p>
          </div>
          <span class="detail-glyph">大</span>
        </div>
        <div class="detail-numbers">${groupsHtml(draw, true)}</div>
      </div>

      <div class="detail-stats">
        <div class="detail-stat"><span>本期销量</span><strong>${formatCny(draw.sales)}</strong></div>
        <div class="detail-stat"><span>奖池滚存</span><strong>${formatCny(draw.pool)}</strong></div>
        <div class="detail-stat"><span>开奖状态</span><strong class="ok">已开奖</strong></div>
      </div>

      <div class="detail-structure">
        <span>和值 <b>${features.sum}</b></span>
        <span>${features.structure}</span>
        <span>跨度 <b>${features.span}</b></span>
        <span>后区和值 <b>${features.backSum}</b></span>
      </div>

      ${draw.next ? `<div class="detail-countdown"><span>${escapeHtml(draw.next.label)}</span><b data-countdown="${escapeHtml(
        draw.next.saleAt,
      )}">--:--:--</b></div>` : ''}
      ${prizeTableHtml(draw)}

      <div class="detail-footer">
        <button class="btn btn-ghost small" id="copyNumbers" type="button">复制号码</button>
        <button class="btn btn-primary small" id="detailTrend" type="button">查看历史走势</button>
      </div>
      <p class="detail-disclaimer">
        数据来源于中国体彩网公开接口，开奖结果与奖级信息以官方最终公布为准。请理性购彩，未满 18 周岁禁止购彩。
      </p>`;

    if (!refs.detailDialog.open) refs.detailDialog.showModal();
    document.body.classList.add('modal-open');
    refs.dialogInner.scrollTop = 0;
    updateCountdowns();

    $('#copyNumbers', refs.dialogBody)?.addEventListener('click', () => {
      copyText(`第${draw.issue}期 大乐透：${front.map(pad2).join(' ')} + ${back.map(pad2).join(' ')}`);
    });
    $('#detailTrend', refs.dialogBody)?.addEventListener('click', () => {
      closeDialog();
      switchView('trend');
    });
  }

  function openDialogLoading() {
    refs.dialogBody.innerHTML = '<div class="trend-loading" style="padding:80px 0">正在加载开奖详情…</div>';
    if (!refs.detailDialog.open) refs.detailDialog.showModal();
    document.body.classList.add('modal-open');
    refs.dialogInner.scrollTop = 0;
  }

  async function openIssue(issue) {
    const current = state.overview?.game;
    if (current && current.issue === issue) {
      openDetail(current);
      return;
    }
    openDialogLoading();
    try {
      const data = await api(`/api/draw?issue=${encodeURIComponent(issue)}`);
      openDetail(data.draw);
    } catch (error) {
      closeDialog();
      showToast(error.message || '开奖详情加载失败', 'error');
    }
  }

  function closeDialog() {
    if (refs.detailDialog.open) refs.detailDialog.close();
    else document.body.classList.remove('modal-open');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('号码已复制');
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        showToast('号码已复制');
      } catch {
        showToast('复制失败，请手动选择号码', 'error');
      }
      textarea.remove();
    }
  }

  function copyAllPredictions() {
    if (!state.prediction.results.length) {
      showToast('还没有可复制的号码', 'error');
      return;
    }
    const batch = currentBatch();
    const lines = state.prediction.results.map(
      (result, index) =>
        `第${index + 1}组 ${result.front.map(pad2).join(' ')} + ${result.back.map(pad2).join(' ')}（${
          (METHODS[result.method] || METHODS.random).label
        }）`,
    );
    const head = batch ? `大乐透第 ${batch.targetIssue} 期参考（仅供娱乐）` : '大乐透下期参考（仅供娱乐）';
    copyText(`${head}\n${lines.join('\n')}`);
  }

  function switchView(view, { scroll = true } = {}) {
    if (!['home', 'trend', 'predict'].includes(view)) return;
    state.view = view;
    refs.views.forEach((section) => section.classList.toggle('is-active', section.id === `view-${view}`));
    refs.navBtns.forEach((button) => button.classList.toggle('active', button.dataset.view === view));

    if (view === 'trend') {
      if (!state.analysis || state.analysis.limit !== state.analysisLimit) {
        loadAnalysis(state.analysisLimit, { force: false });
      } else {
        renderTrend();
      }
    }
    if (view === 'predict') loadPredictions({ silent: true });
    if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
    try {
      window.history.replaceState(null, '', `#${view}`);
    } catch {
      // ignore
    }
  }

  function bindEvents() {
    refs.refreshBtn.addEventListener('click', () => refreshAll(true));
    refs.heroRefresh.addEventListener('click', () => refreshAll(true));
    refs.navBtns.forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));

    document.addEventListener('click', (event) => {
      const viewLink = event.target.closest('[data-view-link]');
      if (viewLink) {
        event.preventDefault();
        switchView(viewLink.dataset.viewLink);
        return;
      }
      const issueTrigger = event.target.closest('[data-open-issue]');
      if (issueTrigger) openIssue(issueTrigger.dataset.openIssue);
    });

    refs.historyBody.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = event.target.closest('[data-open-issue]');
      if (!row) return;
      event.preventDefault();
      openIssue(row.dataset.openIssue);
    });

    refs.issueSearchBtn.addEventListener('click', searchIssue);
    refs.issueInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        searchIssue();
      }
    });
    refs.clearSearchBtn.addEventListener('click', clearHistorySearch);
    refs.pagination.addEventListener('click', (event) => {
      const button = event.target.closest('[data-page]');
      if (!button || button.disabled) return;
      goToHistoryPage(Number(button.dataset.page));
    });

    refs.trendPeriod.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-limit]');
      if (!chip) return;
      state.analysisLimit = Number(chip.dataset.limit);
      $$('.chip', refs.trendPeriod).forEach((item) => {
        const active = item === chip;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', String(active));
      });
      loadAnalysis(state.analysisLimit, { force: true });
    });

    refs.randomBtn.addEventListener('click', randomCheck);
    refs.clearBtn.addEventListener('click', clearCheck);
    refs.checkBtn.addEventListener('click', checkNumbers);

    refs.predictCount?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-count]');
      if (!button) return;
      state.prediction.count = PICK_COUNT;
      $$('button', refs.predictCount).forEach((item) => item.classList.toggle('is-active', item === button));
    });
    refs.birthdayInput.addEventListener('change', () => rememberBirthday(refs.birthdayInput.value));
    refs.birthdayMemoryFill.addEventListener('click', fillBirthdayMemory);
    refs.generateBtn.addEventListener('click', generatePredictions);
    refs.copyAllBtn.addEventListener('click', copyAllPredictions);
    refs.predictResults.addEventListener('click', (event) => {
      const button = event.target.closest('[data-copy-index]');
      if (!button) return;
      const result = state.prediction.results[Number(button.dataset.copyIndex)];
      if (!result) return;
      copyText(
        `${result.front.map(pad2).join(' ')} + ${result.back.map(pad2).join(' ')}（${
          (METHODS[result.method] || METHODS.random).label
        }）`,
      );
    });

    refs.dialogClose.addEventListener('click', closeDialog);
    refs.detailDialog.addEventListener('click', (event) => {
      if (event.target === refs.detailDialog) closeDialog();
    });
    refs.detailDialog.addEventListener('close', () => document.body.classList.remove('modal-open'));

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - state.lastRefreshAt > 30_000) refreshAll(false);
    });
    window.addEventListener('online', () => refreshAll(false));
  }

  async function init() {
    cacheRefs();
    bindEvents();
    renderCheckForm();
    refs.birthdayInput.max = formatToday();
    loadBirthdayMemory();
    updateLiveClock();

    const hash = window.location.hash.replace('#', '');
    const initialView = ['trend', 'predict'].includes(hash) ? hash : 'home';

    await refreshAll(true);
    await loadHistory();
    if (!state.prediction.loaded) await loadPredictions({ silent: true });
    if (initialView !== 'home') switchView(initialView, { scroll: false });

    window.setInterval(() => {
      if (!document.hidden) refreshOverview(false);
    }, 30_000);
    window.setInterval(updateCountdowns, 1000);
    window.setInterval(updateLiveClock, 1000);
    updateCountdowns();
  }

  init().catch((error) => {
    console.error(error);
    showToast('页面初始化失败，请刷新重试', 'error');
  });
})();
