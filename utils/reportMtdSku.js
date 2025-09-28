// utils/reportMtdSku.js
// MTD-отчёт по SKU. Учитываем ТОЛЬКО финоперации, где есть items (операции без items ПРОПУСКАЕМ).
// Выводим: Заказано / Выкуплено / Доставляется / Возвраты / Брак / % выкупа / Д.Р.Р / CTR / Расходы / Прибыль(после рекламы) / Прибыль на шт. / ROI.
// Пороговые иконки (ENV):
//   MTD_PICKUP_WARN_LT          (default 80)   — если % выкупа ниже → 🔻 (иначе ▫️)
//   MTD_DRR_WARN_GT             (default 10)   — если Д.Р.Р выше   → 🔺 (иначе ▫️)
//   MTD_CTR_WARN_LT             (default 2.5)  — если CTR ниже     → 🔻 (иначе ▫️)
//   MTD_ROI_WARN_LT             (default 15)   — если ROI ниже     → 🔻 (иначе ▫️)
//   MTD_PROFIT_WARN_LT          (default 0)    — если прибыль <    → 🔻 (иначе ▫️)
//   MTD_PROFIT_PER_UNIT_WARN_LT (default 100)  — если прибыль/шт < → 🔻 (иначе ▫️)

const { ozonApiRequest } = require('../services/ozon/api');
const { getTodayISO, getYesterdayISO } = require('./utils');
const { getPerSkuStatsFromDaily } = require('../services/performanceApi');

const esc = (s = '') => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const firstWord = (s = '') => (String(s).trim().split(/\s+/)[0] || '');
const fmtMoney0 = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const includesBrak = (s) => typeof s === 'string' && s.toLowerCase().includes('брак');
const fmtPct2 = (x) => (x == null || !Number.isFinite(x))
  ? '—'
  : (Math.round(x * 100) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';

const DEBUG_MTD         = process.env.DEBUG_MTD === '1';
const DEBUG_MTD_DETAILS = process.env.DEBUG_MTD_DETAILS === '1';

const OZON_MAX_RETRIES     = Number(process.env.OZON_MAX_RETRIES || 5);
const OZON_BACKOFF_BASE_MS = Number(process.env.OZON_BACKOFF_BASE_MS || 300);

// Пороговые значения (ENV)
const MTD_PICKUP_WARN_LT           = Number(process.env.MTD_PICKUP_WARN_LT ?? 80);
const MTD_DRR_WARN_GT              = Number(process.env.MTD_DRR_WARN_GT ?? 10);
const MTD_CTR_WARN_LT              = Number(process.env.MTD_CTR_WARN_LT ?? 2.5);
const MTD_ROI_WARN_LT              = Number(process.env.MTD_ROI_WARN_LT ?? 15);
const MTD_PROFIT_WARN_LT           = Number(process.env.MTD_PROFIT_WARN_LT ?? 0);
const MTD_PROFIT_PER_UNIT_WARN_LT  = Number(process.env.MTD_PROFIT_PER_UNIT_WARN_LT ?? 100);

// ---------- период: MTD (с начала месяца по конец вчера) ----------
function getMtdRange() {
  const todayYmd = getTodayISO();
  const yesterdayYmd = getYesterdayISO();
  const [yy, mm] = todayYmd.split('-');
  const monthStartYmd = `${yy}-${mm}-01`;
  return {
    fromYmd: monthStartYmd,
    toYmd:   yesterdayYmd,
    fromISO: `${monthStartYmd}T00:00:00.000Z`,
    toISO:   `${yesterdayYmd}T23:59:59.999Z`,
    monthStartYmd,
    yesterdayYmd,
  };
}

// ---------- ABC (по прибыли ПОСЛЕ рекламы) ----------
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

  const ABC_A_LIMIT = Number(process.env.ABC_A_LIMIT ?? 0.80);
  const ABC_B_LIMIT = Number(process.env.ABC_B_LIMIT ?? 0.95);

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
  // оформление по требованию
  if (cls === 'A') return '▫️ ABC: A';
  if (cls === 'B') return '▫️ ABC: B';
  return '❗ ABC: C';
}

// ---------- период: произвольные N дней, по вчерашнюю дату ----------
function getLastNDaysRange(n = 30) {
  const ymdTo = getYesterdayISO(); // YYYY-MM-DD
  const d = new Date(ymdTo + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() - (n - 1));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const ymdFrom = `${y}-${m}-${day}`;
  return {
    fromYmd: ymdFrom,
    toYmd:   ymdTo,
    fromISO: `${ymdFrom}T00:00:00.000Z`,
    toISO:   `${ymdTo}T23:59:59.999Z`,
    periodStartYmd: ymdFrom,
    periodEndYmd:   ymdTo,
  };
}


// ---------- себестоимость per-unit из БД ----------
async function getCostsMapForTracked(db, chatId, trackedSkus) {
  if (!db || !chatId) return new Map();
  const skus = (Array.isArray(trackedSkus) ? trackedSkus : [])
    .map(Number).filter(Number.isFinite);
  if (!skus.length) return new Map();

  const r = await db.query(`
    SELECT sp.sku::bigint AS sku, COALESCE(sp.net, 0)::numeric AS net
      FROM shop_products sp
      JOIN shops s ON s.id = sp.shop_id
     WHERE s.chat_id = $1
       AND sp.tracked = TRUE
       AND sp.sku = ANY($2::bigint[])`,
    [chatId, skus]
  );
  const map = new Map();
  for (const row of (r.rows || [])) {
    const sku = Number(row.sku);
    if (Number.isFinite(sku)) map.set(sku, Number(row.net) || 0);
  }
  return map;
}

// ---------- analytics: заказы и выручка по SKU ----------
async function fetchAnalyticsSkuBulk({ client_id, api_key, date_from_ymd, date_to_ymd }) {
  const limit = 1000;
  let offset = 0;
  const rows = [];
  for (let attempt = 0; ; attempt++) {
    try {
      while (true) {
        const resp = await ozonApiRequest({
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

// ---------- finance: тянем все операции (но дальше используем ТОЛЬКО те, у которых есть items) ----------
async function fetchFinanceOpsAll({ client_id, api_key, fromISO, toISO }) {
  const page_size = 1000;
  let page = 1;
  const out = [];
  for (let attempt = 0; ; attempt++) {
    try {
      while (true) {
        const resp = await ozonApiRequest({
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

// ---------- postings(FBO): доставляется ----------
async function fetchFboDeliveringCounts({ client_id, api_key, fromISO, toISO, trackedSet }) {
  const limit = 1000;
  let offset = 0;
  const counts = new Map();
  for (let attempt = 0; ; attempt++) {
    try {
      while (true) {
        const resp = await ozonApiRequest({
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

// ---------- returns: сбор возвратов + «брак» ----------
async function fetchReturnsStats({ client_id, api_key, fromISO, toISO, trackedSet }) {
  const limit = 500;
  let last_id = 0;

  const counts = new Map();     // sku -> qty
  const brakCounts = new Map(); // sku -> qty (reason содержит "брак")
  const seen = new Set();

  for (let attempt = 0; ; attempt++) {
    try {
      while (true) {
        const resp = await ozonApiRequest({
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
async function makeMtdPerSkuText(user, { trackedSkus = [], db = null, chatId = null } = {}) {
  // нормализуем tracked
  const tracked = [...new Set(
    (Array.isArray(trackedSkus) ? trackedSkus : [])
      .map(Number).filter(Number.isFinite)
  )];
  if (!tracked.length) return '<code>Нет отслеживаемых товаров для отчёта.</code>';
  const trackedSet = new Set(tracked);

  const { fromYmd, toYmd, fromISO, toISO, monthStartYmd, yesterdayYmd } = getMtdRange();
  if (DEBUG_MTD) console.log('[MTD] range', { fromYmd, toYmd });

  // 1) Заказано за MTD (analytics -> только tracked)
  const analyticsRows = await fetchAnalyticsSkuBulk({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date_from_ymd: fromYmd,
    date_to_ymd:   toYmd,
  });

  const orderedMap = new Map();         // sku -> { ordered, revenue }
  const nameBySku  = new Map();         // sku -> title (из analytics приоритетно)
  for (const row of analyticsRows) {
    const dim = row?.dimensions?.[0];
    const sku = Number(dim?.id);
    if (!Number.isFinite(sku) || !trackedSet.has(sku)) continue;
    const m = Array.isArray(row?.metrics) ? row.metrics : [0, 0];
    orderedMap.set(sku, { revenue: Number(m[0]||0), ordered: Number(m[1]||0) });
    const nm = String(dim?.name || '').trim();
    if (nm) nameBySku.set(sku, nm);
  }

  // 2) Себестоимость (per-unit net) из БД
  const costsMap = await getCostsMapForTracked(db, chatId, tracked);

  // 3) Финансовые операции: учитываем ТОЛЬКО те, где есть items
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
    if (!items.length) continue; // <== НЕТ items — ПРОПУСКАЕМ

    // веса = сумма quantity по items конкретной операции
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

    if (DEBUG_MTD_DETAILS) {
      const pn = op?.posting_number || '-';
      console.log(`[MTD:OP ${pn}] items=${items.length} accr=${accr} comm=${comm} proc=${proc} deliv=${deliv} services=${services} amount=${amount} residual=${residual}`);
    }
  }

  // 4) «Доставляется» + «Возвраты/брак»
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

  // Веса для «все товары» — по брутто-выручке, посчитанной ТОЛЬКО по операциям с items
  const allocationWeights = {};
  for (const sku of tracked) {
    const gr = Number( (agg.get(sku)?.grossAccrPos) || 0 );
    allocationWeights[sku] = gr > 0 ? gr : 0;
  }

  // 5) Рекламные метрики по SKU через daily/json + objects (с учётом весов)
  let ppcBySku = new Map();
  if (db && chatId && typeof getPerSkuStatsFromDaily === 'function') {
    try {
      const rr = await db.query(`
        SELECT performance_client_id, performance_secret
          FROM shops
         WHERE chat_id = $1
           AND performance_client_id IS NOT NULL
           AND performance_secret IS NOT NULL
         ORDER BY id
         LIMIT 1
      `, [chatId]);

      if (rr.rowCount) {
        const perfId     = rr.rows[0].performance_client_id;
        const perfSecret = rr.rows[0].performance_secret;

        ppcBySku = await getPerSkuStatsFromDaily({
          client_id:  perfId,
          client_secret: perfSecret,
          date_from:  fromYmd,
          date_to:    toYmd,
          trackedSkus: tracked,
          allocationWeights, // распределение «все товары» пропорционально выручке
        });
      }
    } catch (e) {
      console.warn('[MTD] Performance daily per-sku error:', e?.response?.status, e?.message);
      ppcBySku = new Map(); // не роняем отчёт
    }
  }

  // ---------- расчёт метрик по каждому SKU (1-й проход) ----------
  const profitBySku = new Map();  // для ABC
  const perSku = new Map();       // для последующего рендера
  let totalProfitAfterAds = 0;

  // сортировка: по брутто-выручке desc, затем по SKU
  const orderSkus = [...tracked].sort((a, b) => {
    const ra = Number(agg.get(a)?.grossAccrPos || 0);
    const rb = Number(agg.get(b)?.grossAccrPos || 0);
    if (rb !== ra) return rb - ra;
    return a - b;
  });

  for (const sku of orderSkus) {
    const ord = orderedMap.get(sku) || { ordered:0, revenue:0 };
    const a   = agg.get(sku)       || { grossAccrPos:0, posCnt:0, negCnt:0, expenses:0 };
    const net = Number(costsMap.get(sku) || 0); // себестоимость за единицу из БД

    const posCnt     = Math.max(0, a.posCnt);
    const negCnt     = Math.max(0, a.negCnt);
    const netCnt     = Math.max(0, posCnt - negCnt);       // выкупленные шт. (по операциям с items)
    const grossRev   = a.grossAccrPos;                     // брутто выручка (Σ accruals_for_sale>0)
    const expenses   = a.expenses;                         // площадочные расходы (комиссии/логистика/услуги/остаток-)

    // Себестоимость по выкупленным
    const costUnits  = netCnt;
    const costTotal  = costUnits * net;

    // Реклама по SKU
    let ctrStr = '—';
    let drrStr = '—';
    let ctr = null;
    let drr = null;
    let adSpend = 0;
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

    // Прибыль ПОСЛЕ рекламы (адресходы вычитаем РОВНО 1 раз здесь)
    const profitBeforeAds = grossRev - expenses - costTotal;
    const profitAfterAds  = profitBeforeAds - adSpend;

    totalProfitAfterAds += profitAfterAds;
    profitBySku.set(sku, profitAfterAds); // ← для ABC

    const titleApi = nameBySku.get(sku) || '';
    const display  = firstWord(titleApi) || `SKU ${sku}`;
    const inTransitQty = Number(inTransitMap.get(sku) || 0);
    const returnsQty   = Number(returnsMap.get(sku) || 0);
    const brakQty      = Number(brakMap.get(sku) || 0);

    // процент выкупа = выкуплено шт / (заказано шт - доставляется шт) * 100
    const denom = Math.max(0, Number(ord.ordered || 0) - Number(inTransitQty || 0));
    let pickupPercentStr = 'н/д';
    let pickupPct = null;
    if (denom > 0) {
      const pct = (netCnt / denom) * 100;
      pickupPct = pct;
      const pctRounded = Math.max(0, Math.min(100, Math.round(pct)));
      pickupPercentStr = `${pctRounded}%`;
    }

    // значки-пороговые
    const pickupIcon = (pickupPct != null && pickupPct < MTD_PICKUP_WARN_LT) ? '🔻' : '▫️';
    const drrIcon    = (drr != null && drr > MTD_DRR_WARN_GT) ? '🔺' : '▫️';
    const ctrIcon    = (ctr != null && ctr < MTD_CTR_WARN_LT) ? '🔻' : '▫️';
    const profitIcon = (Number.isFinite(profitAfterAds) && profitAfterAds < MTD_PROFIT_WARN_LT) ? '🔻' : '▫️';

    // ROI = (profitAfterAds + costTotal) / costTotal × 100
    let roi = null;
    if (costTotal > 0 && Number.isFinite(profitAfterAds)) {
      roi = ((profitAfterAds + costTotal) / costTotal) * 100;
    }
    const roiStr  = fmtPct2(roi);
    const roiIcon = (roi != null && roi < MTD_ROI_WARN_LT) ? '🔻' : '▫️';

    // Прибыль на шт. (по выкупленным)
    const profitPerUnit = netCnt > 0 && Number.isFinite(profitAfterAds)
      ? (profitAfterAds / netCnt)
      : null;
    const ppuIcon = (profitPerUnit != null && profitPerUnit < MTD_PROFIT_PER_UNIT_WARN_LT) ? '🔻' : '▫️';
    const ppuStr  = (profitPerUnit != null) ? `${fmtMoney0(profitPerUnit)}₽` : 'нет';

    if (DEBUG_MTD) {
      const m = (x) => fmtMoney0(x) + ' ₽';
      console.log(`[MTD:ROI ${sku}] ${display}
  grossRev:               ${m(grossRev)}
  expenses (platform):    ${m(expenses)}
  unit cost (DB):         ${m(net)}
  posCnt/negCnt/netCnt:   ${posCnt} / ${negCnt} / ${netCnt}
  units for cost:         ${netCnt} (используем NET)
  costTotal:              ${m(costTotal)}   (= unit cost × units for cost)
  profit (before ads):    ${m(profitBeforeAds)}      (= grossRev - expenses - costTotal)
  adSpend:                ${m(adSpend)}
  profit (after ads):     ${m(profitAfterAds)}       (= profitBeforeAds - adSpend)
ROI ((profit+cost)/cost): ${roiStr}
  profit per unit:        ${ppuStr}`);
    }

    // Сохраняем все для рендера после расчёта ABC
    perSku.set(sku, {
      display, ord,
      inTransitQty, returnsQty, brakQty,
      ctrStr, drrStr,
      expenses,
      profitAfterAds, ppuStr, roiStr,
      pickupPercentStr,
      icons: { pickupIcon, drrIcon, ctrIcon, profitIcon, ppuIcon, roiIcon },
      // для строк с деньгами/количествами:
      netCnt, grossRev,
    });
  }

  // ---------- ABC (после 1-го прохода, по прибыли) ----------
  const abcMap = computeAbcByProfit(profitBySku);

  // ---------- вывод (2-й проход) ----------
  const lines = [];
  lines.push(`<code>🏪 Магазин: ${esc(user.shop_name || 'Неизвестно')}</code>`);
  lines.push('<code> - - - - </code>');
  lines.push(`<code>📆 Период: ${esc(monthStartYmd)} → ${esc(yesterdayYmd)}</code>`);
  lines.push('<code> - - - - </code>');

  const qtyLine = (n) => Number(n) ? `${Math.round(Number(n)).toLocaleString('ru-RU')} шт.` : 'нет';
  const qtyMoneyLine = (qty, sum) =>
    Number(qty) ? `${Math.round(Number(qty)).toLocaleString('ru-RU')} шт. на ${fmtMoney0(sum)}₽` : 'нет';

  for (const sku of orderSkus) {
    const s = perSku.get(sku);
    if (!s) continue;

    const {
      display, ord,
      inTransitQty, returnsQty, brakQty,
      ctrStr, drrStr,
      expenses,
      profitAfterAds, ppuStr, roiStr,
      pickupPercentStr,
      icons,
      netCnt, grossRev,
    } = s;

    const abcClass = abcMap.get(sku) || 'C';
    const abcStr   = abcBadge(abcClass);

    lines.push(`<code>📦 ${esc(display)} (${sku})</code>`);
    lines.push(`<code>▫️ Заказано: ${qtyMoneyLine(ord.ordered, ord.revenue)}</code>`);
    lines.push(`<code>▫️ Выкуплено: ${qtyMoneyLine(netCnt, grossRev)}</code>`);
    lines.push(`<code>▫️ Доставляется: ${qtyLine(inTransitQty)}</code>`);
    lines.push(`<code>▫️ Возвраты: ${qtyLine(returnsQty)}</code>`);
    lines.push(`<code>▫️ Брак (в возвратах): ${qtyLine(brakQty)}</code>`);
    lines.push(`<code>${icons.pickupIcon} Процент выкупа: ${pickupPercentStr}</code>`);
    lines.push(`<code>${icons.drrIcon} Д.Р.Р: ${drrStr}</code>`);
    lines.push(`<code>${icons.ctrIcon} CTR: ${ctrStr}</code>`);
    lines.push(`<code>▫️ Расходы: ${Number(expenses) ? `${fmtMoney0(expenses)}₽` : 'нет'}</code>`);
    lines.push(`<code>${icons.profitIcon} Прибыль: ${Number.isFinite(profitAfterAds) ? `${fmtMoney0(profitAfterAds)}₽` : 'нет'}</code>`);
    lines.push(`<code>${icons.ppuIcon} Прибыль на шт.: ${ppuStr}</code>`);
    lines.push(`<code>${icons.roiIcon} ROI: ${roiStr}</code>`);
    lines.push(`<code>${abcStr}</code>`);
    lines.push('<code> - - - - </code>');
  }

  // итог по прибыли — СУММА ПОСЛЕ РЕКЛАМЫ
  lines.push(`<code>💰 Общая прибыль: ${fmtMoney0(totalProfitAfterAds)}₽</code>`);
  return lines.join('\n');
}

// ---------- отчёт за последние 30 дней (по вчерашнюю) ----------
async function makeLast30PerSkuText(user, { trackedSkus = [], db = null, chatId = null } = {}) {
  const tracked = [...new Set((Array.isArray(trackedSkus) ? trackedSkus : [])
    .map(Number).filter(Number.isFinite))];
  if (!tracked.length) return '<code>Нет отслеживаемых товаров для отчёта.</code>';
  const trackedSet = new Set(tracked);

  const { fromYmd, toYmd, fromISO, toISO, periodStartYmd, periodEndYmd } = getLastNDaysRange(30);
  if (DEBUG_MTD) console.log('[LAST30] range', { fromYmd, toYmd });

  // 1) analytics: заказано/выручка по SKU (для «Заказано» и fallback на имена)
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

  // 3) финоперации (только где есть items) — как в MTD
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
  }

// 4) доставляется + возвраты/брак
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

  // 5) реклама per-SKU (allocation по grossAccrPos)
  const allocationWeights = {};
  for (const sku of tracked) {
    const gr = Number( (agg.get(sku)?.grossAccrPos) || 0 );
    allocationWeights[sku] = gr > 0 ? gr : 0;
  }

  let ppcBySku = new Map();
  if (db && chatId && typeof getPerSkuStatsFromDaily === 'function') {
    try {
      const rr = await db.query(`
        SELECT performance_client_id, performance_secret
          FROM shops
         WHERE chat_id = $1
           AND performance_client_id IS NOT NULL
           AND performance_secret IS NOT NULL
         ORDER BY id
         LIMIT 1
      `, [chatId]);
      if (rr.rowCount) {
        const perfId     = rr.rows[0].performance_client_id;
        const perfSecret = rr.rows[0].performance_secret;
        ppcBySku = await getPerSkuStatsFromDaily({
          client_id:  perfId,
          client_secret: perfSecret,
          date_from:  fromYmd,
          date_to:    toYmd,
          trackedSkus: tracked,
          allocationWeights,
        });
      }
    } catch (e) {
      console.warn('[LAST30] Performance daily per-sku error:', e?.response?.status, e?.message);
      ppcBySku = new Map();
    }
  }

  // ---------- 1-й проход: посчитать прибыль по каждому SKU и подготовить данные для рендера ----------
  // сортировка: по брутто-выручке desc, затем по SKU
  const orderSkus = [...tracked].sort((a, b) => {
    const ra = Number(agg.get(a)?.grossAccrPos || 0);
    const rb = Number(agg.get(b)?.grossAccrPos || 0);
    if (rb !== ra) return rb - ra;
    return a - b;
  });

  const profitBySku = new Map(); // для ABC
  const perSku = new Map();      // кэш строк/значений для вывода
  let totalProfitAfterAds = 0;

  for (const sku of orderSkus) {
    const ord = orderedMap.get(sku) || { ordered:0, revenue:0 };
    const a   = agg.get(sku)       || { grossAccrPos:0, posCnt:0, negCnt:0, expenses:0 };
    const net = Number(costsMap.get(sku) || 0);

    const posCnt   = Math.max(0, a.posCnt);
    const negCnt   = Math.max(0, a.negCnt);
    const netCnt   = Math.max(0, posCnt - negCnt);
    const grossRev = a.grossAccrPos;
    const expenses = a.expenses;

    const costTotal = netCnt * net;

    // реклама/метрики
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

    // ПРИБЫЛЬ — как в MTD
    const profitBeforeAds = grossRev - expenses - costTotal;
    const profitAfterAds  = profitBeforeAds - adSpend;

    totalProfitAfterAds += profitAfterAds;
    profitBySku.set(sku, profitAfterAds); // <— для ABC

    const titleApi = nameBySku.get(sku) || '';
    const display  = firstWord(titleApi) || `SKU ${sku}`;

    // pickup% для last30 — по заказам (без «доставляется»)
    const denomOrdered = Number(ord.ordered || 0);
    let pickupPercentStr = 'н/д';
    let pickupPct = null;
    if (denomOrdered > 0) {
      const pct = (netCnt / denomOrdered) * 100;
      pickupPct = pct;
      pickupPercentStr = `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
    }
    const pickupIcon = (pickupPct != null && pickupPct < MTD_PICKUP_WARN_LT) ? '🔻' : '▫️';
    const drrIcon    = (drr != null && drr > MTD_DRR_WARN_GT) ? '🔺' : '▫️';
    const ctrIcon    = (ctr != null && ctr < MTD_CTR_WARN_LT) ? '🔻' : '▫️';
    const profitIcon = (Number.isFinite(profitAfterAds) && profitAfterAds < MTD_PROFIT_WARN_LT) ? '🔻' : '▫️';

    // ROI и прибыль/шт.
    let roi = null;
    if (costTotal > 0 && Number.isFinite(profitAfterAds)) {
      roi = ((profitAfterAds + costTotal) / costTotal) * 100;
    }
    const roiStr  = fmtPct2(roi);
    const roiIcon = (roi != null && roi < MTD_ROI_WARN_LT) ? '🔻' : '▫️';

    const profitPerUnit = netCnt > 0 && Number.isFinite(profitAfterAds)
      ? (profitAfterAds / netCnt) : null;
    const ppuStr  = (profitPerUnit != null) ? `${fmtMoney0(profitPerUnit)}₽` : 'нет';
    const ppuIcon = (profitPerUnit != null && profitPerUnit < MTD_PROFIT_PER_UNIT_WARN_LT) ? '🔻' : '▫️';

perSku.set(sku, {
  display, ord,
  ctrStr, drrStr,
  expenses,
  profitAfterAds, ppuStr, roiStr,
  icons: { pickupIcon, drrIcon, ctrIcon, profitIcon, ppuIcon, roiIcon },
  pickupPercentStr,
  netCnt, grossRev,
  inTransitQty: Number(inTransitMap.get(sku) || 0), // ← ДОБАВИЛИ
  returnsQty: Number(returnsMap.get(sku) || 0),
  brakQty:    Number(brakMap.get(sku)    || 0),
});
  }

  // ---------- ABC (по прибыли после рекламы) ----------
  const abcMap = computeAbcByProfit(profitBySku);

  // ---------- 2-й проход: вывод ----------
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
  display, ord, ctrStr, drrStr, expenses,
  profitAfterAds, ppuStr, roiStr,
  icons, pickupPercentStr, netCnt, grossRev,
  inTransitQty,                 // ← ДОБАВИЛИ
  returnsQty, brakQty,
} = s;

const denom = Math.max(0, Number(ord.ordered || 0) - Number(inTransitQty || 0));
let pickupStr = 'н/д';
let pickupPct = null;
if (denom > 0) {
  const pct = (netCnt / denom) * 100;
  pickupPct = pct;
  pickupStr = `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
}

    const abcClass = abcMap.get(sku) || 'C';
    const abcStr   = abcBadge(abcClass);

    lines.push(`<code>📦 ${esc(display)} (${sku})</code>`);
lines.push(`<code>▫️ Заказано: ${qtyMoneyLine(ord.ordered, ord.revenue)}</code>`);
lines.push(`<code>▫️ Выкуплено: ${qtyMoneyLine(netCnt, grossRev)}</code>`);
lines.push(`<code>▫️ Доставляется: ${qtyLine(inTransitQty)}</code>`);     // ← ДОБАВИЛИ
lines.push(`<code>▫️ Возвраты: ${qtyLine(returnsQty)}</code>`);
lines.push(`<code>▫️ Брак (в возвратах): ${qtyLine(brakQty)}</code>`);
lines.push(`<code>${icons.pickupIcon} Процент выкупа: ${pickupStr}</code>`); // ← ИСПОЛЬЗУЕМ новую переменную
lines.push(`<code>${icons.drrIcon} Д.Р.Р: ${drrStr}</code>`);
lines.push(`<code>${icons.ctrIcon} CTR: ${ctrStr}</code>`);
lines.push(`<code>▫️ Расходы: ${Number(expenses) ? `${fmtMoney0(expenses)}₽` : 'нет'}</code>`);
lines.push(`<code>${icons.profitIcon} Прибыль: ${Number.isFinite(profitAfterAds) ? `${fmtMoney0(profitAfterAds)}₽` : 'нет'}</code>`);
lines.push(`<code>${icons.ppuIcon} Прибыль на шт.: ${ppuStr}</code>`);
lines.push(`<code>${icons.roiIcon} ROI: ${roiStr}</code>`);
lines.push(`<code>${abcStr}</code>`);
lines.push('<code> - - - - </code>');

  }

  lines.push(`<code>💰 Общая прибыль: ${fmtMoney0(totalProfitAfterAds)}₽</code>`);
  return lines.join('\n');
}


module.exports = {
  makeMtdPerSkuText,
  makeLast30PerSkuText
};