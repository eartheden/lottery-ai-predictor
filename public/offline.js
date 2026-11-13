/**
 * 静态托管兼容层（GitHub Pages / 任意纯静态环境）
 *
 * 本站在本地是跑在 server.mjs 上的，页面全程走 /api/*。
 * 到了纯静态环境没有后端，这个文件会把 window.fetch 接住：
 *   - 先试真实后端：本地开发时一切照旧，这个文件等于不存在
 *   - 后端不通：切到静态模式，用 docs/data/offline.json 里的快照顶上前端要的数据
 *   - 预测存档 / 生日设置这类要写库的，退化成浏览器的 localStorage（每台设备各自一份）
 *
 * 快照由 scripts/build-static.mjs 生成，构建时会把真实后端的 /api 响应原样存下来，
 * 所以分析口径跟后端完全一致，不需要在前端重写一遍。
 */
(function () {
  var BUNDLE_URL = new URL('data/offline.json', document.baseURI).href;
  var LS_PRED = 'lottery.static.predictions.v1';
  var LS_SETTING = 'lottery.static.settings.v1';
  var MAX_BATCHES = 60;
  var MAX_PICKS = 20;
  var METHOD_KEYS = ['birthday', 'random', 'ai', 'cosmos', 'chaos', 'markov'];

  var DLT_TIERS = {
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
  var TIER_ORDER = ['一等奖', '二等奖', '三等奖', '四等奖', '五等奖', '六等奖', '七等奖'];

  var originalFetch = window.fetch ? window.fetch.bind(window) : null;
  var staticMode = null; // null=还没判定 true=纯静态 false=有后端
  var bundlePromise = null;

  function loadBundle() {
    if (!bundlePromise) {
      bundlePromise = fetch(BUNDLE_URL, { cache: 'no-store' }).then(function (res) {
        if (!res.ok) throw new Error('静态数据快照缺失（' + res.status + '）');
        return res.json();
      });
    }
    return bundlePromise;
  }

  function reply(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  function fail(message, status) {
    return reply({ success: false, error: message }, status || 503);
  }

  function readJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  }

  /* ---------- 期号推导（与 server.mjs 的 computeNextIssue 保持一致） ---------- */
  function computeNextIssue(latestIssue, nextDrawAt) {
    var n = parseInt(latestIssue, 10);
    if (!isFinite(n)) return null;
    var issueYear = Math.floor(n / 1000);
    var drawYear = issueYear;
    if (nextDrawAt) {
      var at = new Date(nextDrawAt);
      if (!isNaN(at.getTime())) {
        var year = Number(
          new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(at),
        );
        if (isFinite(year)) drawYear = year % 100;
      }
    }
    if (drawYear !== issueYear) return String(drawYear).padStart(2, '0') + '001';
    return String(n + 1);
  }

  function normalizeBallList(raw, length, min, max) {
    if (!Array.isArray(raw) || raw.length !== length) return null;
    var values = raw.map(Number);
    if (!values.every(function (n) {
      return Number.isInteger(n) && n >= min && n <= max;
    })) return null;
    if (new Set(values).size !== length) return null;
    return values.sort(function (a, b) {
      return a - b;
    });
  }

  /* ---------- 开奖后结算（金额拿不到，等级照算） ---------- */
  function settleBatch(batch, draw) {
    var actualFront = draw.groups[0].balls.map(Number);
    var actualBack = draw.groups[1].balls.map(Number);
    var winCount = 0;
    var bestTier = null;

    batch.results = (batch.results || []).map(function (pick) {
      var frontHits = pick.front.filter(function (n) {
        return actualFront.indexOf(n) >= 0;
      }).length;
      var backHits = pick.back.filter(function (n) {
        return actualBack.indexOf(n) >= 0;
      }).length;
      var tier = DLT_TIERS[frontHits + '+' + backHits] || null;
      if (tier) {
        winCount += 1;
        if (!bestTier || TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(bestTier)) bestTier = tier;
      }
      return Object.assign({}, pick, {
        frontHits: frontHits,
        backHits: backHits,
        tier: tier,
        prizeAmount: null,
        frontHitFlags: pick.front.map(function (n) {
          return actualFront.indexOf(n) >= 0;
        }),
        backHitFlags: pick.back.map(function (n) {
          return actualBack.indexOf(n) >= 0;
        }),
      });
    });

    batch.status = 'settled';
    batch.settledAt = new Date().toISOString();
    batch.winCount = winCount;
    batch.bestTier = bestTier;
    batch.draw = {
      issue: draw.issue,
      drawDate: draw.drawDate || draw.date || '',
      resultText: draw.resultText || '',
      groups: draw.groups,
      prizeLevels: [],
    };
    return true;
  }

  function findDraw(bundle, issue) {
    var target = String(issue);
    for (var i = 0; i < bundle.draws.length; i += 1) {
      if (String(bundle.draws[i].issue) === target) return bundle.draws[i];
    }
    return null;
  }

  /* ---------- 各接口的静态实现 ---------- */
  function handleOverview(bundle) {
    return reply(Object.assign({}, bundle.overview, { cached: true }));
  }

  function handleHistory(bundle, params) {
    var page = clampInt(params.get('page'), 1, 9999, 1);
    var pageSize = clampInt(params.get('pageSize'), 1, 50, 10);
    var start = (page - 1) * pageSize;
    var total = bundle.draws.length;
    return reply({
      success: true,
      gameNo: bundle.overview?.game?.no || '85',
      page: page,
      pageSize: pageSize,
      total: total,
      pages: Math.ceil(total / pageSize),
      draws: bundle.draws.slice(start, start + pageSize),
    });
  }

  function handleDraw(bundle, params) {
    var issue = (params.get('issue') || 'latest').trim();
    if (issue === 'latest') return reply(Object.assign({}, bundle.overview.game, { success: true }));
    var draw = findDraw(bundle, issue);
    if (!draw) throw new Error('快照里没有第 ' + issue + ' 期，静态站只保留最近约 4 年数据');
    return reply(Object.assign({}, draw, { success: true }));
  }

  function handleAnalysis(bundle, params) {
    var limit = clampInt(params.get('limit'), 20, 100, 50);
    var keys = Object.keys(bundle.analysis).map(Number).sort(function (a, b) {
      return a - b;
    });
    var picked = keys[0];
    for (var i = 0; i < keys.length; i += 1) {
      if (keys[i] <= limit) picked = keys[i];
    }
    return reply(bundle.analysis[picked]);
  }

  function settleAll(bundle) {
    var store = readJson(LS_PRED, { batches: [] });
    var changed = false;
    store.batches.forEach(function (batch) {
      if (batch.status !== 'pending') return;
      if (String(bundle.latestIssue) === String(batch.baseIssue)) return;
      var draw = findDraw(bundle, batch.targetIssue);
      if (draw && settleBatch(batch, draw)) changed = true;
    });
    if (changed) writeJson(LS_PRED, store);
    return store;
  }

  function predictionState(bundle) {
    var store = settleAll(bundle);
    var nextIssue = computeNextIssue(bundle.latestIssue, bundle.nextDrawAt);
    var active =
      store.batches.filter(function (batch) {
        return batch.status === 'pending' && String(batch.targetIssue) === String(nextIssue);
      })[0] || null;
    return {
      success: true,
      asOf: new Date().toISOString(),
      latestIssue: bundle.latestIssue,
      nextIssue: nextIssue,
      nextDrawAt: bundle.nextDrawAt,
      activeBatch: active,
      batches: store.batches,
      storage: 'browser',
    };
  }

  function createBatch(bundle, body) {
    var baseIssue = String((body && body.baseIssue) || '').trim();
    var targetIssue = String((body && body.targetIssue) || '').trim();
    if (!/^\d{5,7}$/.test(baseIssue) || !/^\d{5,7}$/.test(targetIssue)) {
      throw new Error('期号格式不正确');
    }
    var incoming = Array.isArray(body && body.results) ? body.results.slice(0, MAX_PICKS) : [];
    if (!incoming.length) throw new Error('缺少号码数据');

    var results = incoming.map(function (item) {
      var front = normalizeBallList(item && item.front, 5, 1, 35);
      var back = normalizeBallList(item && item.back, 2, 1, 12);
      if (!front || !back) throw new Error('号码格式不正确');
      return {
        front: front,
        back: back,
        method: METHOD_KEYS.indexOf(item && item.method) >= 0 ? item.method : 'random',
        reason: String((item && item.reason) || '').slice(0, 240),
        features: item && typeof item.features === 'object' ? item.features : null,
      };
    });

    var store = settleAll(bundle);
    var batch = {
      id: targetIssue + '-' + Date.now(),
      baseIssue: baseIssue,
      targetIssue: targetIssue,
      targetDrawAt: (body && body.targetDrawAt) || null,
      createdAt: new Date().toISOString(),
      status: 'pending',
      methods: Array.isArray(body && body.methods)
        ? body.methods.filter(function (key) {
            return METHOD_KEYS.indexOf(key) >= 0;
          })
        : [],
      birthday: String((body && body.birthday) || '').slice(0, 20),
      seed: String((body && body.seed) || '').slice(0, 40),
      analysisLimit: Number(body && body.analysisLimit) || null,
      results: results,
      winCount: 0,
      bestTier: null,
      draw: null,
    };

    var existing = -1;
    store.batches.forEach(function (item, index) {
      if (item.status === 'pending' && String(item.targetIssue) === String(targetIssue)) existing = index;
    });
    if (existing >= 0) {
      batch.id = store.batches[existing].id;
      store.batches.splice(existing, 1);
    }
    store.batches.unshift(batch);
    if (store.batches.length > MAX_BATCHES) store.batches.length = MAX_BATCHES;
    writeJson(LS_PRED, store);
    return batch;
  }

  function handleSettings(method, body) {
    var store = readJson(LS_SETTING, { lastBirthday: '', updatedAt: null });
    if (method === 'GET') return reply({ success: true, lastBirthday: store.lastBirthday || '', updatedAt: store.updatedAt || null });
    var value = String((body && body.lastBirthday) || '').trim();
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail('生日格式不正确，应为 YYYY-MM-DD', 400);
    store.lastBirthday = value;
    store.updatedAt = new Date().toISOString();
    writeJson(LS_SETTING, store);
    return reply({ success: true, lastBirthday: store.lastBirthday, updatedAt: store.updatedAt });
  }

  function clampInt(value, min, max, fallback) {
    var n = parseInt(value, 10);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function route(bundle, pathname, params, method, body) {
    if (pathname === '/api/health') return reply({ success: true, static: true, generatedAt: bundle.generatedAt });
    if (pathname === '/api/overview') return handleOverview(bundle);
    if (pathname === '/api/history') return handleHistory(bundle, params);
    if (pathname === '/api/draw') return handleDraw(bundle, params);
    if (pathname === '/api/analysis') return handleAnalysis(bundle, params);
    if (pathname === '/api/predictions') {
      if (method === 'POST') {
        var created = createBatch(bundle, body);
        // 与后端保持一致：POST 返回整个预测状态，前端 applyPredictionState 直接吃这个结构
        return reply(Object.assign(predictionState(bundle), { created: created }));
      }
      return reply(predictionState(bundle));
    }
    if (pathname === '/api/settings') return handleSettings(method, body);
    return null;
  }

  if (!originalFetch) return;

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var match = url.match(/\/api\/[a-z]+/i);
    if (!match) return originalFetch(input, init);

    var method = String((init && init.method) || 'GET').toUpperCase();

    function runStatic() {
      var parsed = new URL(url, document.baseURI);
      var params = parsed.searchParams;
      var body = null;
      if (init && init.body) {
        try {
          body = JSON.parse(init.body);
        } catch (error) {
          body = null;
        }
      }
      return loadBundle().then(function (bundle) {
        var response = route(bundle, match[0], params, method, body);
        return response || fail('静态站不支持该接口：' + match[0], 501);
      });
    }

    if (staticMode === true) return runStatic();

    return originalFetch(input, init).then(
      function (response) {
        // 后端存在：本地开发 / 自建服务器
        if (response.ok || (response.status !== 404 && response.status !== 405 && response.status !== 501)) {
          staticMode = staticMode === null ? false : staticMode;
          return response;
        }
        staticMode = true;
        return runStatic();
      },
      function () {
        staticMode = true;
        return runStatic();
      },
    );
  };

  // 静态模式下给页面加个标识，方便前端提示「数据为定时快照」
  Object.defineProperty(window, '__LOTTERY_STATIC__', {
    value: Object.create(null, {
      enabled: {
        enumerable: true,
        get: function () {
          return staticMode === true;
        },
      },
    }),
  });
})();
