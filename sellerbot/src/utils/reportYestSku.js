// src/utils/reportLastMsku.js
// Отчёт per-SKU за ПРОШЛЫЙ календарный месяц (как в /last30, но за прошлый месяц).
// Экспорт:
//   - makeLastMPerSkuText(user, { trackedSkus, db, chatId })
//   - makeLastMTextAndData(user, { trackedSkus, db, chatId }) -> { text, items, periodLabel }
//
// user: { client_id, seller_api, shop_name? }
// trackedSkus: number[]
//
// Требуемые поля БД:
//   shops.perf_client_id, shops.perf_client_secret  (Performance API)
//
// Зависимости: services/ozon, services/performanceApi
//

const oz = require('../services/ozon');

let perf = null;
try { perf = require('../services/performanceApi'); } catch { perf = null; }

// ---------- форматтеры ----------
const esc = (s='') => String(s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmtInt    = (n) => (Math.round(Number(n) || 0)).toLocaleString('ru-RU');
const fmtMoney0 = (n) => (Math.round(Number(n) || 0)).toLocaleString('ru-RU');
const fmtPct2   = (n) => (n == null || !isFinite(n))
  ? null
  : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + '%';

// ---------- ENV пороги (можно править без деплоя) ----------
function getNum(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}
const TH = {
  drrHigh:  getNum('DRR_HIGH', 10),     // %
  ctrLow:   getNum('CTR_LOW',  2.5),    // %
  roiLow:   getNum('ROI_LOW',  0),      // %  (ниже — подсветка)
};

// ---------- даты ----------
function getPrevMonthRangeUTC() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0..11 (текущий)
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last  = new Date(Date.UTC(y, m, 0));
  const iso = (d) => {
    const yy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  };
  return { from: iso(first), to: iso(last) };
}
function* daysIter(fromISO, toISO) {
  const [fy,fm,fd] = fromISO.split('-').map(Number);
  const [ty,tm,td] = toISO.split('-').map(Number);
  let d = new Date(Date.UTC(fy, fm - 1, fd));
  const end = new Date(Date.UTC(ty, tm - 1, td));
  while (d <= end) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    yield `${y}-${m}-${day}`;
    d = new Date(d.getTime() + 86400_000);
  }
}

// ---------- универсальный oz-request ----------
async function ozRequest({ client_id, api_key, endpoint, body }) {
  try {
    if (typeof oz.ozonApiRequest === 'function') {
      return await oz.ozonApiRequest({ client_id, api_key, endpoint, body });
    }
    if (oz.api && typeof oz.api.request === 'function') {
      return await oz.api.request({ client_id, api_key, endpoint, body });
    }
    if (typeof oz.request === 'function') {
      return await oz.request({ client_id, api_key, endpoint, body });
    }
    throw new Error('Ozon API request function not found');
  } catch (e) {
    if (process.env.DEBUG_LASTM === '1') {
      console.warn('[lastM] ozRequest error', endpoint, e?.response?.data || e.message);
    }
    return null;
  }
}
async function safeCall(fn, fallback, args) {
  try { return await fn(args); } catch { return fallback; }
}

// ---------- Performance creds ----------
async function getPerformanceCreds(db, chatId) {
  // perf_client_id / perf_client_secret  (как договорились)
  const q = await db.query(
    `SELECT s.perf_client_id, s.perf_client_secret
       FROM shops s
       JOIN users u ON u.id = s.user_id
      WHERE u.chat_id = $1
      ORDER BY s.created_at DESC NULLS LAST, s.id DESC
      LIMIT 1`,
    [chatId]
  );
  if (!q.rowCount) return null;
  const row = q.rows[0];
  if (!row.perf_client_id || !row.perf_client_secret) return null;
  return { client_id: row.perf_client_id, client_secret: row.perf_client_secret };
}

// ---------- Перекаст рекламы per-SKU за период ----------
async function getPerSkuSpendForRange({ client_id, client_secret, from, to, trackedSkus, allocationWeights = null }) {
  if (!perf || typeof perf.getPerSkuStatsFromDaily !== 'function') return new Map();
  const map = await perf.getPerSkuStatsFromDaily({
    client_id, client_secret,
    date_from: from, date_to: to,
    trackedSkus,
    allocationWeights,
  });
  const out = new Map();
  for (const [sku, v] of map.entries()) {
    const spent  = Number(v?.spent || 0);
    const views  = Number(v?.views || 0);
    const clicks = Number(v?.clicks || 0);
    out.set(Number(sku), { spent, views, clicks });
  }
  return out;
}

// ---------- Названия товаров по SKU ----------
async function getNamesBySku({ client_id, api_key }, skus) {
  const skuSet = Array.from(new Set((skus || []).map(Number).filter(Number.isFinite)));
  if (!skuSet.length) return new Map();

  // 1) sku -> product_id через /v4/product/info/stocks
  const skuToPid = new Map();
  let cursor = '';
  for (let page = 0; page < 30; page++) {
    const r = await ozRequest({
      client_id, api_key,
      endpoint: '/v4/product/info/stocks',
      body: { cursor, filter: { visibility: 'ALL' }, limit: 100 },
    });
    const items = r?.result?.items || r?.items || [];
    for (const it of items) {
      const pid = Number(it?.product_id || it?.id || 0);
      for (const st of (it?.stocks || [])) {
        const sku = Number(st?.sku || 0);
        if (skuSet.includes(sku) && pid) skuToPid.set(sku, pid);
      }
    }
    const next = r?.result?.cursor ?? r?.cursor ?? '';
    cursor = typeof next === 'string' ? next : '';
    if (!cursor) break;
    if (skuToPid.size >= skuSet.length) break;
  }
  const pids = Array.from(new Set([...skuToPid.values()].filter(Number.isFinite)));
  if (!pids.length) return new Map();

  // 2) /v3/product/info/list по product_id -> name
  const names = new Map();
  for (let i = 0; i < pids.length; i += 100) {
    const part = pids.slice(i, i + 100).map(String);
    const r = await ozRequest({
      client_id, api_key,
      endpoint: '/v3/product/info/list',
      body: { product_id: part },
    });
    const resItems = r?.result?.items || r?.items || [];
    for (const it of resItems) {
      const pid = Number(it?.id || it?.product_id || 0);
      const name = String(it?.name || it?.title || '').trim();
      if (!pid || !name) continue;
      for (const [sku, p] of skuToPid.entries()) {
        if (p === pid) names.set(sku, name);
      }
    }
  }
  return names; // Map<sku, name>
}

// ---------- Аналитика per-SKU за период (заказы/выручка) ----------
async function getOrderedAndRevenueBySku({ client_id, api_key }, fromISO, toISO, trackedSkus) {
  const out = new Map(); // sku -> { ordered: n, revenue: ₽ }
  const tracked = new Set((trackedSkus || []).map(Number).filter(Number.isFinite));

  const body = {
    dimension: ['sku'],
    metrics: ['ordered_units', 'revenue'],
    filters: [
      { key: 'date_from', value: fromISO },
      { key: 'date_to',   value: toISO },
    ],
    limit: 1000,
  };

  const r = await ozRequest({
    client_id, api_key,
    endpoint: '/v1/analytics/data',
    body,
  });

  const rows = r?.result?.data || r?.data || r?.result || [];
  for (const row of rows) {
    const sku = Number(row?.sku || row?.SKU || row?.dimension?.sku || 0);
    if (!Number.isFinite(sku)) continue;
    if (tracked.size && !tracked.has(sku)) continue;
    const ordered = Number(row?.ordered_units ?? row?.ordered ?? row?.orders ?? 0);
    const revenue = Number(row?.revenue ?? row?.gmv ?? 0);
    const cur = out.get(sku) || { ordered: 0, revenue: 0 };
    cur.ordered += ordered;
    cur.revenue += revenue;
    out.set(sku, cur);
  }

  return out;
}

// ---------- Выкуп/доставляется per-SKU через postings FBS ----------
async function getDeliveredAndDeliveringBySku({ client_id, api_key }, fromISO, toISO, trackedSkus) {
  const tracked = new Set((trackedSkus || []).map(Number).filter(Number.isFinite));
  const res = {
    delivered: new Map(),   // sku -> { qty, amount }
    delivering: new Map(),  // sku -> qty
  };

  async function scan(status, collector) {
    let last_id = '';
    for (let page = 0; page < 100; page++) {
      const r = await ozRequest({
        client_id, api_key,
        endpoint: '/v3/posting/fbs/list',
        body: {
          filter: {
            status, since: `${fromISO}T00:00:00.000Z`, to: `${toISO}T23:59:59.999Z`,
          },
          limit: 100,
          last_id,
          with: { analytics_data: true, financial_data: true },
        },
      });
      const postings = r?.result?.postings || r?.postings || [];
      for (const p of postings) {
        const prods = p?.products || [];
        for (const pr of prods) {
          const sku = Number(pr?.sku || 0);
          if (!Number.isFinite(sku)) continue;
          if (tracked.size && !tracked.has(sku)) continue;
          const qty = Number(pr?.quantity || pr?.qty || 0);
          const amount = Number(pr?.price || pr?.sale_amount || pr?.sum || 0);
          collector(sku, qty, amount);
        }
      }
      const next = r?.result?.last_id ?? r?.last_id ?? '';
      if (!next || next === last_id) break;
      last_id = next;
    }
  }

  await scan('delivered', (sku, qty, amount) => {
    const cur = res.delivered.get(sku) || { qty: 0, amount: 0 };
    cur.qty    += qty;
    cur.amount += amount;
    res.delivered.set(sku, cur);
  });

  await scan('delivering', (sku, qty) => {
    const cur = res.delivering.get(sku) || { qty: 0 };
    cur.qty += qty;
    res.delivering.set(sku, cur);
  });

  return res;
}

// ---------- Возвраты/брак per-SKU (best-effort) ----------
async function getReturnsBySku({ client_id, api_key }, fromISO, toISO, trackedSkus) {
  const tracked = new Set((trackedSkus || []).map(Number).filter(Number.isFinite));
  const returns = new Map(); // sku -> qty
  const defects = new Map(); // sku -> qty (брак в возвратах)

  // Попытка: /v2/returns/company/fbs (если доступно)
  const r = await ozRequest({
    client_id, api_key,
    endpoint: '/v2/returns/company/fbs',
    body: {
      filter: { since: `${fromISO}T00:00:00.000Z`, to: `${toISO}T23:59:59.999Z` },
      limit: 1000,
      offset: 0,
    },
  });

  const arr = r?.result?.returns || r?.returns || [];
  for (const it of arr) {
    const sku = Number(it?.sku || it?.product?.sku || 0);
    if (!Number.isFinite(sku)) continue;
    if (tracked.size && !tracked.has(sku)) continue;
    const isDefect = Boolean(it?.is_bad || it?.is_defect || it?.defect);
    const cur = returns.get(sku) || 0;
    returns.set(sku, cur + 1);
    if (isDefect) defects.set(sku, (defects.get(sku) || 0) + 1);
  }

  return { returns, defects };
}

// ---------- ABC-классификация по выручке ----------
function abcClassify(items) {
  const sorted = [...items].sort((a,b) => (b.revenue||0)-(a.revenue||0));
  const total = sorted.reduce((s,x)=>s+(Number(x.revenue)||0),0);
  let acc = 0;
  for (const it of sorted) {
    const share = total > 0 ? (it.revenue / total) * 100 : 0;
    acc += share;
    if (acc <= 80) it.abc = 'A';
    else if (acc <= 95) it.abc = 'B';
    else it.abc = 'C';
  }
}

// ---------- Сбор per-SKU данных ----------
async function buildLastMData(user, { trackedSkus, db, chatId }) {
  const { from, to } = getPrevMonthRangeUTC();
  const skus = Array.from(new Set((trackedSkus||[]).map(Number).filter(Number.isFinite)));
  if (!skus.length) return { periodLabel: `${from} → ${to}`, items: [] };

  const credsPerf = db && chatId ? await getPerformanceCreds(db, chatId) : null;

  // 1) Заказано/выручка (analytics)
  const ordMap = await getOrderedAndRevenueBySku(
    { client_id: user.client_id, api_key: user.seller_api },
    from, to, skus
  );

  // 2) Выкуп/доставляется (postings FBS)
  const post = await getDeliveredAndDeliveringBySku(
    { client_id: user.client_id, api_key: user.seller_api },
    from, to, skus
  );

  // 3) Возвраты/брак (best-effort)
  const ret = await getReturnsBySku(
    { client_id: user.client_id, api_key: user.seller_api },
    from, to, skus
  );

  // 4) Реклама per-SKU (Perf)
  let ppc = new Map();
  if (credsPerf && perf && typeof perf.getPerSkuStatsFromDaily === 'function') {
    try {
      ppc = await getPerSkuSpendForRange({
        client_id: credsPerf.client_id,
        client_secret: credsPerf.client_secret,
        from, to,
        trackedSkus: skus,
        allocationWeights: null,
      });
    } catch (e) {
      if (process.env.DEBUG_LASTM === '1') {
        console.warn('[lastM] perf per-sku error', e?.response?.data || e.message);
      }
    }
  }

  // 5) Названия
  const nameMap = await getNamesBySku({ client_id: user.client_id, api_key: user.seller_api }, skus);

  // 6) Сбор per-SKU
  const items = [];
  for (const sku of skus) {
    const ord = ordMap.get(sku) || { ordered: 0, revenue: 0 };
    const del = post.delivered.get(sku) || { qty: 0, amount: 0 };
    const ship = post.delivering.get(sku) || { qty: 0 };
    const retQty = (ret.returns.get(sku) || 0);
    const badQty = (ret.defects.get(sku) || 0);
    const p = ppc.get(sku) || { spent: 0, views: 0, clicks: 0 };

    items.push({
      sku,
      title: nameMap.get(sku) || '',
      ordered: Number(ord.ordered || 0),
      revenue: Number(ord.revenue || 0),
      deliveredQty: Number(del.qty || 0),
      deliveredAmount: Number(del.amount || 0),
      deliveringQty: Number(ship.qty || 0),
      returnsQty: Number(retQty || 0),
      defectQty: Number(badQty || 0),
      ad_spend: Number(p.spent || 0),
      views: Number(p.views || 0),
      clicks: Number(p.clicks || 0),
    });
  }

  // 7) Производные метрики: DRR, CTR, profit/roi, buyoutRate
  for (const it of items) {
    it.drr = (it.revenue > 0 && it.ad_spend > 0) ? (it.ad_spend / it.revenue) * 100 : null;
    it.ctr = (it.views > 0 && it.clicks >= 0) ? (it.clicks / it.views) * 100 : null;

    // Прибыль за период (best-effort): deliveredAmount - ad_spend
    const profitAfterAds = Number.isFinite(it.deliveredAmount)
      ? (it.deliveredAmount - (it.ad_spend || 0))
      : null;
    it.profit = profitAfterAds;

    // Прибыль на шт.
    it.ppu = (it.deliveredQty > 0 && Number.isFinite(profitAfterAds))
      ? (profitAfterAds / it.deliveredQty)
      : null;

    // ROI = profit / ad_spend * 100
    it.roi = (it.ad_spend > 0 && Number.isFinite(profitAfterAds))
      ? (profitAfterAds / it.ad_spend) * 100
      : null;

    // Процент выкупа: deliveredQty / (ordered - deliveringQty)
    const denom = (it.ordered - it.deliveringQty);
    it.buyoutRate = (denom > 0 && it.deliveredQty >= 0)
      ? (it.deliveredQty / denom) * 100
      : null;
  }

  // 8) ABC по выручке
  abcClassify(items);

  return { periodLabel: `${from} → ${to}`, items };
}

// ---------- Рендер текста ----------
function firstWord(s='') {
  const t = String(s).trim();
  if (!t) return '';
  const m = t.match(/^[^,|–—-]+/);
  return (m ? m[0] : t).trim();
}

function drrIcon(val) {
  if (val == null || !isFinite(val)) return '▫️';
  return val > TH.drrHigh ? '🔺' : '▫️';
}
function ctrIcon(val) {
  if (val == null || !isFinite(val)) return '▫️';
  return val < TH.ctrLow ? '🔻' : '▫️';
}
function roiIcon(val) {
  if (val == null || !isFinite(val)) return '▫️';
  return val < TH.roiLow ? '🔻' : '▫️';
}
function profitIcon(val) {
  if (val == null || !isFinite(val)) return '▫️';
  return val < 0 ? '🔻' : '▫️';
}

function qtyMoneyLine(qty, money) {
  if (!Number(qty)) return 'нет';
  return `${fmtInt(qty)} шт. на ${fmtMoney0(money)}₽`;
}
function qtyLine(qty) {
  if (!Number(qty)) return 'нет';
  return `${fmtInt(qty)} шт.`;
}

function buildText(shopName, periodLabel, items) {
  const lines = [];
  lines.push(`<code>🏪 Магазин: ${esc(shopName || '—')}</code>`);
  lines.push('<code> - - - - </code>');
  lines.push(`<code>📆 Период: ${esc(periodLabel)}</code>`);
  lines.push('<code> - - - - </code>');

  for (const it of items) {
    const title = firstWord(it.title) || `SKU ${it.sku}`;

    const drrStr = it.drr != null ? fmtPct2(it.drr) : '—';
    const ctrStr = it.ctr != null ? fmtPct2(it.ctr) : '—';
    const roiStr = it.roi != null ? fmtPct2(it.roi) : '—';
    const ppuStr = (it.ppu != null && isFinite(it.ppu)) ? `${fmtMoney0(it.ppu)}₽` : '—';
    const buyoutStr = it.buyoutRate != null ? fmtPct2(it.buyoutRate) : '—';

    lines.push(`<code>📦 ${esc(title)} (${it.sku})</code>`);
    lines.push(`<code>▫️ Заказано: ${qtyMoneyLine(it.ordered, it.revenue)}</code>`);
    lines.push(`<code>▫️ Выкуплено: ${qtyMoneyLine(it.deliveredQty, it.deliveredAmount)}</code>`);
    lines.push(`<code>▫️ Доставляется: ${fmtInt(it.deliveringQty)} шт.</code>`);
    lines.push(`<code>▫️ Возвраты: ${qtyLine(it.returnsQty)}</code>`);
    lines.push(`<code>▫️ Брак (в возвратах): ${it.defectQty ? qtyLine(it.defectQty) : 'нет'}</code>`);
    lines.push(`<code>▫️ Процент выкупа: ${buyoutStr}</code>`);
    lines.push(`<code>${drrIcon(it.drr)} Д.Р.Р: ${drrStr}</code>`);
    lines.push(`<code>${ctrIcon(it.ctr)} CTR: ${ctrStr}</code>`);
    lines.push(`<code>▫️ Расходы: ${Number(it.ad_spend) ? `${fmtMoney0(it.ad_spend)}₽` : 'нет'}</code>`);
    lines.push(`<code>${profitIcon(it.profit)} Прибыль: ${Number.isFinite(it.profit) ? `${fmtMoney0(it.profit)}₽` : 'нет'}</code>`);
    lines.push(`<code>${profitIcon(it.ppu)} Прибыль на шт.: ${ppuStr}</code>`);
    lines.push(`<code>${roiIcon(it.roi)} ROI: ${roiStr}</code>`);
    lines.push(`<code>▫️ ABC: ${it.abc || '—'}</code>`);
    lines.push('<code> - - - - </code>');
  }

  return lines.join('\n');
}

// ---------- Публичные функции ----------
async function makeLastMPerSkuText(user, { trackedSkus, db, chatId }) {
  const { periodLabel, items } = await buildLastMData(user, { trackedSkus, db, chatId });
  // ABC-классы уже проставлены в buildLastMData
  return buildText(user.shop_name || '', periodLabel, items);
}

async function makeLastMTextAndData(user, { trackedSkus, db, chatId }) {
  const { periodLabel, items } = await buildLastMData(user, { trackedSkus, db, chatId });
  const text = buildText(user.shop_name || '', periodLabel, items);
  return { text, items, periodLabel };
}

module.exports = {
  makeLastMPerSkuText,
  makeLastMTextAndData,
};
