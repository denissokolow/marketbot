// src/utils/reportLastMsku.js
// Отчёт /lastM: прошлый календарный месяц (с 1 по последний день) с разбивкой по SKU.
// Метрики и индикации идентичны /last30.

const oz = require('../services/ozon');
const perfApi = require('../services/performanceApi');

// ---------- совместимость вызова Ozon API ----------
async function ozonApiRequestCompat({ client_id, api_key, endpoint, body }) {
  if (typeof oz.ozonApiRequest === 'function') {
    return oz.ozonApiRequest({ client_id, api_key, endpoint, body });
  }
  if (oz.api && typeof oz.api.request === 'function') {
    return oz.api.request({ client_id, api_key, endpoint, body });
  }
  if (typeof oz.request === 'function') {
    return oz.request({ client_id, api_key, endpoint, body });
  }
  throw new Error('Ozon API request function not found');
}

// ---------- утилиты ----------
const esc = (s = '') => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const firstWord = (s = '') => (String(s).trim().split(/\s+/)[0] || '');
const fmtMoney0 = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU');
const includesBrak = (s) => typeof s === 'string' && s.toLowerCase().includes('брак');
const fmtPct2 = (x) => (x == null || !Number.isFinite(x))
  ? '—'
  : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x) + '%';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- DEBUG/ретраи ----------
const DEBUG_LASTM         = process.env.DEBUG_LASTM === '1';
const DEBUG_LASTM_DETAILS = process.env.DEBUG_LASTM_DETAILS === '1';
const OZON_MAX_RETRIES     = Number(process.env.OZON_MAX_RETRIES || 5);
const OZON_BACKOFF_BASE_MS = Number(process.env.OZON_BACKOFF_BASE_MS || 300);

// ---------- пороги (те же, что для /last30) ----------
const MTD_PICKUP_WARN_LT           = Number(process.env.MTD_PICKUP_WARN_LT ?? 80);
const MTD_DRR_WARN_GT              = Number(process.env.MTD_DRR_WARN_GT ?? 10);
const MTD_CTR_WARN_LT              = Number(process.env.MTD_CTR_WARN_LT ?? 2.5);
const MTD_ROI_WARN_LT              = Number(process.env.MTD_ROI_WARN_LT ?? 15);
const MTD_PROFIT_WARN_LT           = Number(process.env.MTD_PROFIT_WARN_LT ?? 0);
const MTD_PROFIT_PER_UNIT_WARN_LT  = Number(process.env.MTD_PROFIT_PER_UNIT_WARN_LT ?? 100);
const ABC_A_LIMIT                  = Number(process.env.ABC_A_LIMIT ?? 0.80);
const ABC_B_LIMIT                  = Number(process.env.ABC_B_LIMIT ?? 0.95);

// ---------- период: полный прошлый месяц (Europe/Moscow) ----------
function getPrevMonthRange() {
  // Текущая дата в Москве
  const now = new Date();
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).reduce((m,p)=> (m[p.type]=p.value, m), {});
  let y = Number(parts.year);
  let m = Number(parts.month);

  // предыдущий месяц
  m -= 1;
  if (m === 0) { m = 12; y -= 1; }

  const mm   = String(m).padStart(2, '0');
  const fromYmd = `${y}-${mm}-01`;

  // последний день месяца: берём 1-е число следующего месяца минус 1 день
  let y2 = y, m2 = m + 1;
  if (m2 === 13) { m2 = 1; y2 += 1; }
  const lastDate = new Date(Date.UTC(y2, m2 - 1, 1));
  lastDate.setUTCDate(0); // предыдущий день = последний день целевого месяца
  const lastDay = String(lastDate.getUTCDate()).padStart(2, '0');
  const toYmd = `${y}-${mm}-${lastDay}`;

  return {
    fromYmd,
    toYmd,
    fromISO: `${fromYmd}T00:00:00.000Z`,
    toISO:   `${toYmd}T23:59:59.999Z`,
    periodStartYmd: fromYmd,
    periodEndYmd:   toYmd,
  };
}

// ---------- ABC по прибыли ПОСЛЕ рекламы ----------
function computeAbcByProfit(profitBySkuMap) {
  const arr = [];
  let totalPositive = 0;
  profitBySkuMap.forEach((profit, sku) => {
    const p = Number(profit) || 0;
    arr.push({ sku, profit: p });
    if (p > 0) totalPositive += p;
  });
  if (totalPositive <= 0) {
    const out = new Map();
    profitBySkuMap.forEach((_, sku) => out.set(sku, 'C'));
    return out;
  }
  arr.sort((a, b) => b.profit - a.profit);

  const out = new Map();
  let cum = 0;
  for (const { sku, profit } of arr) {
    if (profit <= 0) { out.set(sku, 'C'); continue; }
    cum += profit;
    const share = cum / totalPositive;
    if (share <= ABC_A_LIMIT) out.set(sku, 'A');
    else if (share <= ABC_B_LIMIT) out.set(sku, 'B');
    else out.set(sku, 'C');
  }
  return out;
}
function abcBadge(cls) {
  if (cls === 'A') return '▫️ ABC: A';
  if (cls === 'B') return '▫️ ABC: B';
  return '❗ ABC: C';
}

// ---------- себестоимость per-unit из БД ----------
async function hasColumn(db, table, column) {
  const r = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, column]
  );
  return r.rowCount > 0;
}
async function getCostsMapForTracked(db, chatId, trackedSkus) {
  if (!db || !chatId) return new Map();
  const skus = (Array.isArray(trackedSkus) ? trackedSkus : [])
    .map(Number).filter(Number.isFinite);
  if (!skus.length) return new Map();

  const trackedExists = await hasColumn(db, 'shop_products', 'tracked');
  const sql = trackedExists
    ? `
      SELECT sp.sku::bigint AS sku, COALESCE(sp.net, 0)::numeric AS net
        FROM shop_products sp
        JOIN shops s ON s.id = sp.shop_id
        JOIN users u ON u.id = s.user_id
       WHERE u.chat_id = $1
         AND sp.tracked = TRUE
         AND sp.sku = ANY($2::bigint[])`
    : `
      SELECT sp.sku::bigint AS sku, COALESCE(sp.net, 0)::numeric AS net
        FROM shop_products sp
        JOIN shops s ON s.id = sp.shop_id
        JOIN users u ON u.id = s.user_id
       WHERE u.chat_id = $1
         AND sp.sku = ANY($2::bigint[])`;

  const r = await db.query(sql, [chatId, skus]);
  const map = new Map();
  for (const row of (r.rows || [])) {
    const sku = Number(row.sku);
    if (Number.isFinite(sku)) map.set(sku, Number(row.net) || 0);
  }
  return map;
}

// ---------- analytics: заказано/выручка по SKU ----------
async function fetchAnalyticsSkuBulk({ client_id, api_key, date_from_ymd, date_to_ymd }) {
  const limit = 1000;
  let offset = 0;
  const rows = [];
  for (let attempt = 0; ; attempt++) {
    try {
      while (true) {
        const resp = await ozonApiRequestCompat({
          client_id, api_key,
          endpoint: '/v1/analytics/data',
          body: {
            date_from: date_from_ymd,
            date_to:   date_to_ymd,
            metrics:   ['revenue', 'ordered_units'],
            dimension: ['sku'],
            sort: [{ key: 'revenue', order: 'DESC' }],
            limit,
            offset,
          },
        });
        const data = Array.isArray(resp?.result?.data) ? resp.result.data
                   : Array.isArray(resp?.data)        ? resp.data
                   : [];
        rows.push(...data);
        if (data.length < limit) break;
        offset += data.length;
      }
      break;
    } catch (e) {
      const code = e?.response?.data?.code ?? e?.code;
      if (code === 429 && attempt < OZON_MAX_RETRIES - 1) {
        const pause = OZON_BACKOFF_BASE_MS * Math.pow(2, attempt);
        await sleep(pause); continue;
      }
      throw e;
    }
  }
  return rows;
}

// ---------- finance ops: берём ТОЛЬКО операции, где есть items ----------
async function fetchFinanceOpsAll({ client_id, api_key, fromISO, toISO }) {
  const page_size = 1000;
  let page = 1;
  const out = [];
  for (let attempt = 0; ; attempt++) {
    try {
      while (true) {
        const resp = await ozonApiRequestCompat({
          client_id, api_key,
          endpoint: '/v3/finance/transaction/list',
          body: {
            filter: {
              date: { from: fromISO, to: toISO },
              operation_type: [],
              posting_number: '',
              transaction_type: 'all',
            },
            page,
            page_size,
          },
        });
        const ops = Array.isArray(resp?.result?.operations) ? resp.result.operations : [];
        out.push(...ops);
        if (resp?.result?.has_next === true) page += 1; else break;
      }
      break;
    } catch (e) {
      const code = e?.response?.data?.code ?? e?.code;
      if (code === 429 && attempt < OZON_MAX_RETRIES - 1) {
        const pause = OZON_BACKOFF_BASE_MS * Math.pow(2, attempt);
        await sleep(pause); continue;
      }
      throw e;
    }
  }
  return out;
}

// ---------- postings FBO: «доставляется» ----------
async function fetchFboDeliveringCounts({ client_id, api_key, fromISO, toISO, trackedSet }) {
  const limit = 1000;
  let offset = 0;
  const counts = new Map();
  for (let attempt = 0; ; attempt++) {
    try {
      while (true) {
        const resp = await ozonApiRequestCompat({
          client_id, api_key,
          endpoint: '/v2/posting/fbo/list',
          body: {
            filter: { since: fromISO, to: toISO, status: 'delivering' },
            limit,
            offset,
            translit: false,
            with: { analytics_data: false, financial_data: true, legal_info: false },
          },
        });
        const postings = Array.isArray(resp?.result) ? resp.result
                        : Array.isArray(resp)        ? resp
                        : [];
        for (const p of postings) {
          if (String(p?.status || '').toLowerCase() !== 'delivering') continue;
          for (const pr of (p?.products || [])) {
            const sku = Number(pr?.sku || pr?.offer_id || 0);
            if (!Number.isFinite(sku) || (trackedSet && !trackedSet.has(sku))) continue;
            const qty = Number(pr?.quantity || pr?.qty || 0);
            counts.set(sku, (counts.get(sku) || 0) + (Number.isFinite(qty) ? qty : 0));
          }
        }
        if (postings.length < limit) break;
        offset += postings.length;
      }
      break;
    } catch (e) {
      const code = e?.response?.data?.code ?? e?.code;
      if (code === 429 && attempt < OZON_MAX_RETRIES - 1) {
        const pause = OZON_BACKOFF_BASE_MS * Math.pow(2, attempt);
        await sleep(pause); continue;
      }
      throw e;
    }
  }
  return counts;
}

// ---------- returns: количество + брак ----------
async function fetchReturnsStats({ client_id, api_key, fromISO, toISO, trackedSet }) {
  const limit = 500;
  let last_id = 0;

  const counts = new Map();     // sku -> qty
  const brakCounts = new Map(); // sku -> qty
  const seen = new Set();

  for (let attempt = 0; ; attempt++) {
    try {
      while (true) {
        const resp = await ozonApiRequestCompat({
          client_id, api_key,
          endpoint: '/v1/returns/list',
          body: {
            filter: { logistic_return_date: { time_from: fromISO, time_to: toISO } },
            limit,
            last_id,
          },
        });

        const result = resp?.result || resp || {};
        const items = Array.isArray(result?.returns) ? result.returns : [];
        if (!items.length) break;

        for (const rt of items) {
          const sku = Number(rt?.sku ?? rt?.product?.sku ?? rt?.product_id?.sku ?? 0);
          if (!Number.isFinite(sku) || (trackedSet && !trackedSet.has(sku))) continue;

          const id  = rt?.id ?? rt?.return_id ?? rt?.acceptance_id ?? null;
          const pn  = rt?.posting_number || rt?.posting?.posting_number || '';
          const idx = rt?.item_index ?? rt?.item_id ?? rt?.index ?? 0;
          const key = id != null ? `id:${id}` : `pn:${pn}|sku:${sku}|idx:${idx}`;
          if (seen.has(key)) continue; seen.add(key);

          const q = Number.isFinite(Number(rt?.quantity))
            ? Number(rt?.quantity)
            : Number.isFinite(Number(rt?.return_count)) ? Number(rt?.return_count)
            : Number.isFinite(Number(rt?.qty)) ? Number(rt?.qty)
            : 1;

          counts.set(sku, (counts.get(sku) || 0) + q);

          const reason = rt?.return_reason_name || rt?.reason || '';
          if (includesBrak(reason)) brakCounts.set(sku, (brakCounts.get(sku) || 0) + q);
        }

        const next = Number(result?.last_id ?? 0);
        if (!next || next === last_id) break;
        last_id = next;
      }
      break;
    } catch (e) {
      const code = e?.response?.data?.code ?? e?.code;
      if (code === 429 && attempt < OZON_MAX_RETRIES - 1) {
        const pause = OZON_BACKOFF_BASE_MS * Math.pow(2, attempt);
        await sleep(pause); continue;
      }
      throw e;
    }
  }

  return { counts, brakCounts };
}

// распределение value по SKU на основе весов (Map<sku, weight>)
function splitByWeights(total, weightsMap) {
  let totalW = 0;
  weightsMap.forEach(w => totalW += w);
  if (totalW <= 0) return new Map();
  const res = new Map();
  weightsMap.forEach((w, sku) => {
    res.set(sku, (total * w) / totalW);
  });
  return res;
}

// ---------- основной рендер ----------
async function makeLastMPerSkuText(user, { trackedSkus = [], db = null, chatId = null } = {}) {
  // нормализуем tracked
  const tracked = [...new Set((Array.isArray(trackedSkus) ? trackedSkus : [])
    .map(Number).filter(Number.isFinite))];
  if (!tracked.length) return '<code>Нет отслеживаемых товаров для отчёта.</code>';
  const trackedSet = new Set(tracked);

  const { fromYmd, toYmd, fromISO, toISO, periodStartYmd, periodEndYmd } = getPrevMonthRange();
  if (DEBUG_LASTM) console.log('[LASTM] range', { fromYmd, toYmd });

  // 1) analytics: заказано/выручка по SKU
  const analyticsRows = await fetchAnalyticsSkuBulk({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date_from_ymd: fromYmd,
    date_to_ymd:   toYmd,
  });
  const orderedMap = new Map();
  const nameBySku  = new Map();
  for (const row of analyticsRows) {
    const dim = row?.dimensions?.[0];
    const sku = Number(dim?.id);
    if (!Number.isFinite(sku) || !trackedSet.has(sku)) continue;
    const m = Array.isArray(row?.metrics) ? row.metrics : [0, 0];
    orderedMap.set(sku, { revenue: Number(m[0]||0), ordered: Number(m[1]||0) });
    const nm = String(dim?.name || '').trim();
    if (nm) nameBySku.set(sku, nm);
  }

  // 2) себестоимость per-unit из БД
  const costsMap = await getCostsMapForTracked(db, chatId, tracked);

  // 3) финоперации (ТОЛЬКО где есть items) → брутто выручка/шт/расходы
  const ops = await fetchFinanceOpsAll({
    client_id: user.client_id,
    api_key:   user.seller_api,
    fromISO,
    toISO,
  });

  const agg = new Map(); // sku -> { grossAccrPos, posCnt, negCnt, expenses }
  const ensure = (sku) => {
    let v = agg.get(sku);
    if (!v) { v = { grossAccrPos:0, posCnt:0, negCnt:0, expenses:0 }; agg.set(sku, v); }
    return v;
  };

  for (const op of ops) {
    const items = Array.isArray(op?.items) ? op.items : [];
    if (!items.length) continue;

    // веса по количеству позиций
    const weights = new Map();
    for (const it of items) {
      const sku = Number(it?.sku || 0);
      if (!Number.isFinite(sku) || !trackedSet.has(sku)) continue;
      const w = Number(it?.quantity || 1);
      weights.set(sku, (weights.get(sku) || 0) + (Number.isFinite(w) ? w : 1));
      if (!nameBySku.has(sku) && it?.name) nameBySku.set(sku, String(it.name));
    }
    if (weights.size === 0) continue;

    const accr  = Number(op?.accruals_for_sale || 0);
    const comm  = Number(op?.sale_commission || 0);
    const proc  = Number(op?.processing_and_delivery || 0);
    const deliv = Number(op?.delivery_charge || 0);
    let services = 0;
    const srv = Array.isArray(op?.services) ? op.services : [];
    for (const s of srv) services += Number(s?.price || 0);

    const amount = Number(op?.amount || 0);
    const residual = amount - (accr + comm + proc + deliv + services);
    const residualNeg = residual < 0 ? residual : 0;

    const accrPos = accr > 0 ? accr : 0;
    const accrPosParts = splitByWeights(accrPos, weights);
    const commParts  = splitByWeights(comm,  weights);
    const procParts  = splitByWeights(proc,  weights);
    const delivParts = splitByWeights(deliv, weights);
    const servParts  = splitByWeights(services, weights);
    const residParts = splitByWeights(residualNeg, weights);

    weights.forEach((w, sku) => {
      const slot = ensure(sku);
      slot.grossAccrPos += (accrPosParts.get(sku) || 0);
      if (accr > 0) slot.posCnt += w;
      else if (accr < 0) slot.negCnt += w;

      const e =
        Math.abs(commParts.get(sku)  || 0) +
        Math.abs(procParts.get(sku)  || 0) +
        Math.abs(delivParts.get(sku) || 0) +
        Math.abs(servParts.get(sku)  || 0) +
        Math.abs(residParts.get(sku) || 0);
      slot.expenses += e;
    });

    if (DEBUG_LASTM_DETAILS) {
      const pn = op?.posting_number || '-';
      console.log(`[LASTM:OP ${pn}] accr=${accr} comm=${comm} proc=${proc} deliv=${deliv} services=${services} amount=${amount} residual=${residual}`);
    }
  }

  // 4) «доставляется» + «возвраты/брак»
  const [inTransitMap, returnsStats] = await Promise.all([
    fetchFboDeliveringCounts({
      client_id: user.client_id,
      api_key:   user.seller_api,
      fromISO,
      toISO,
      trackedSet,
    }),
    fetchReturnsStats({
      client_id: user.client_id,
      api_key:   user.seller_api,
      fromISO,
      toISO,
      trackedSet,
    }),
  ]);
  const returnsMap = returnsStats.counts;
  const brakMap    = returnsStats.brakCounts;

  // Веса для кампаний «все товары»: пропорционально брутто-выручке SKU (по финоперациям с items)
  const allocationWeights = {};
  for (const sku of tracked) {
    const gr = Number( (agg.get(sku)?.grossAccrPos) || 0 );
    allocationWeights[sku] = gr > 0 ? gr : 0;
  }

  // 5) Рекламные метрики per-SKU за период (views/clicks/spent) через Performance
  let ppcBySku = new Map();
  if (db && chatId && typeof perfApi.getPerSkuStatsFromDaily === 'function') {
    try {
      const rr = await db.query(`
        SELECT
          s.perf_client_id     AS client_id,
          s.perf_client_secret AS client_secret
        FROM shops s
        JOIN users u ON u.id = s.user_id
        WHERE u.chat_id = $1
          AND s.perf_client_id     IS NOT NULL
          AND s.perf_client_secret IS NOT NULL
        ORDER BY s.created_at DESC NULLS LAST, s.id DESC
        LIMIT 1
      `, [chatId]);

      if (rr.rowCount) {
        ppcBySku = await perfApi.getPerSkuStatsFromDaily({
          client_id: rr.rows[0].client_id,
          client_secret: rr.rows[0].client_secret,
          date_from: fromYmd,
          date_to:   toYmd,
          trackedSkus: tracked,
          allocationWeights,
        });
      }
    } catch (e) {
      console.warn('[LASTM] Performance daily per-sku error:', e?.response?.status, e?.message);
      ppcBySku = new Map();
    }
  }

  // ---------- расчёты по каждому SKU ----------
  const orderSkus = [...tracked].sort((a, b) => {
    const ra = Number(agg.get(a)?.grossAccrPos || 0);
    const rb = Number(agg.get(b)?.grossAccrPos || 0);
    if (rb !== ra) return rb - ra;
    return a - b;
  });

  const profitBySku = new Map(); // для ABC
  const perSku      = new Map(); // кеш строк/значений для вывода

  for (const sku of orderSkus) {
    const ord = orderedMap.get(sku) || { ordered:0, revenue:0 };
    const a   = agg.get(sku)       || { grossAccrPos:0, posCnt:0, negCnt:0, expenses:0 };
    const net = Number((await getCostsMapForTracked(db, chatId, [sku])).get(sku) || 0);

    const posCnt   = Math.max(0, a.posCnt);
    const negCnt   = Math.max(0, a.negCnt);
    const netCnt   = Math.max(0, posCnt - negCnt); // выкупленные шт.
    const grossRev = a.grossAccrPos;               // брутто выручка (Σ accruals_for_sale>0)
    const expenses = a.expenses;                   // площадочные расходы
    const costTotal = netCnt * net;                // себестоимость по выкупленным

    // реклама
    let ctrStr = '—', drrStr = '—', ctr = null, drr = null, adSpend = 0;
    const adv = ppcBySku.get(sku);
    if (adv) {
      const views  = Math.round(Number(adv.views || 0));
      const clicks = Math.round(Number(adv.clicks || 0));
      adSpend = Number(adv.spent || 0) || 0;
      ctr = views > 0 ? (clicks / views) * 100 : null;
      drr = (grossRev > 0 && adSpend >= 0) ? (adSpend / grossRev) * 100 : null;
      ctrStr = fmtPct2(ctr);
      drrStr = fmtPct2(drr);
    }

    // прибыль ПОСЛЕ рекламы
    const profitBeforeAds = grossRev - expenses - costTotal;
    const profitAfterAds  = profitBeforeAds - adSpend;

    const titleApi = nameBySku.get(sku) || '';
    const display  = firstWord(titleApi) || `SKU ${sku}`;

    perSku.set(sku, {
      display, ord,
      grossRev, netCnt,
      inTransitQty: Number(inTransitMap.get(sku) || 0),
      returnsQty: Number(returnsMap.get(sku) || 0),
      brakQty:    Number(brakMap.get(sku)    || 0),
      ctrStr, drrStr,
      expenses,
      profitAfterAds,
      costTotal,
    });
    profitBySku.set(sku, profitAfterAds);
  }

  // ---------- ABC по прибыли после рекламы ----------
  const abcMap = computeAbcByProfit(profitBySku);

  // ---------- вывод ----------
  const lines = [];
  lines.push(`<code>🏪 Магазин: ${esc(user.shop_name || 'Неизвестно')}</code>`);
  lines.push('<code> - - - - </code>');
  lines.push(`<code>📆 Период: ${esc(periodStartYmd)} → ${esc(periodEndYmd)}</code>`);
  lines.push('<code> - - - - </code>');

  const qtyLine = (n) => Number(n) ? `${Math.round(Number(n)).toLocaleString('ru-RU')} шт.` : 'нет';
  const qtyMoneyLine = (qty, sum) =>
    Number(qty) ? `${Math.round(Number(qty)).toLocaleString('ru-RU')} шт. на ${fmtMoney0(sum)}₽` : 'нет';

  for (const sku of orderSkus) {
    const s = perSku.get(sku);
    if (!s) continue;

    const {
      display, ord, grossRev, netCnt,
      inTransitQty, returnsQty, brakQty,
      ctrStr, drrStr, expenses, profitAfterAds, costTotal,
    } = s;

    // % выкупа: выкупленные / (заказано - доставляется) * 100
    const denom = Math.max(0, Number(ord.ordered || 0) - Number(inTransitQty || 0));
    let pickupStr = 'н/д';
    let pickupPct = null;
    if (denom > 0) {
      const pct = (netCnt / denom) * 100;
      pickupPct = pct;
      pickupStr = `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
    }

    // ROI и прибыль/шт.
    let roi = null;
    if (costTotal > 0 && Number.isFinite(profitAfterAds)) {
      roi = ((profitAfterAds + costTotal) / costTotal) * 100;
    }
    const roiStr = fmtPct2(roi);
    const profitPerUnit = netCnt > 0 && Number.isFinite(profitAfterAds)
      ? (profitAfterAds / netCnt) : null;
    const ppuStr  = (profitPerUnit != null) ? `${fmtMoney0(profitPerUnit)}₽` : 'нет';

    // иконки-пороги
    const pickupIcon = (pickupPct != null && pickupPct < MTD_PICKUP_WARN_LT) ? '🔻' : '▫️';
    const drrIcon    = (drrStr !== '—' && Number(drrStr.replace(',', '.')) > MTD_DRR_WARN_GT) ? '🔺' : '▫️';
    const ctrIcon    = (ctrStr !== '—' && Number(ctrStr.replace(',', '.')) < MTD_CTR_WARN_LT) ? '🔻' : '▫️';
    const profitIcon = (Number.isFinite(profitAfterAds) && profitAfterAds < MTD_PROFIT_WARN_LT) ? '🔻' : '▫️';
    const roiIcon    = (roi != null && roi < MTD_ROI_WARN_LT) ? '🔻' : '▫️';
    const ppuIcon    = (profitPerUnit != null && profitPerUnit < MTD_PROFIT_PER_UNIT_WARN_LT) ? '🔻' : '▫️';

    const abcClass = abcMap.get(sku) || 'C';
    const abcStr   = abcBadge(abcClass);

    lines.push(`<code>📦 ${esc(display)} (${sku})</code>`);
    lines.push(`<code>▫️ Заказано: ${qtyMoneyLine(ord.ordered, ord.revenue)}</code>`);
    lines.push(`<code>▫️ Выкуплено: ${qtyMoneyLine(netCnt, grossRev)}</code>`);
    lines.push(`<code>▫️ Доставляется: ${qtyLine(inTransitQty)}</code>`);
    lines.push(`<code>▫️ Возвраты: ${qtyLine(returnsQty)}</code>`);
    lines.push(`<code>▫️ Брак (в возвратах): ${qtyLine(brakQty)}</code>`);
    lines.push(`<code>${pickupIcon} Процент выкупа: ${pickupStr}</code>`);
    lines.push(`<code>${drrIcon} Д.Р.Р: ${drrStr}</code>`);
    lines.push(`<code>${ctrIcon} CTR: ${ctrStr}</code>`);
    lines.push(`<code>▫️ Расходы: ${Number(expenses) ? `${fmtMoney0(expenses)}₽` : 'нет'}</code>`);
    lines.push(`<code>${profitIcon} Прибыль: ${Number.isFinite(profitAfterAds) ? `${fmtMoney0(profitAfterAds)}₽` : 'нет'}</code>`);
    lines.push(`<code>${ppuIcon} Прибыль на шт.: ${ppuStr}</code>`);
    lines.push(`<code>${roiIcon} ROI: ${roiStr}</code>`);
    lines.push(`<code>${abcStr}</code>`);
    lines.push('<code> - - - - </code>');
  }

  const totalProfitAfterAdsFormatted = fmtMoney0(
    [...profitBySku.values()].reduce((a, b) => a + (Number(b) || 0), 0)
  );
  lines.push(`<code>💰 Общая прибыль: ${totalProfitAfterAdsFormatted}₽</code>`);

  return lines.join('\n');
}

module.exports = { makeLastMPerSkuText };
