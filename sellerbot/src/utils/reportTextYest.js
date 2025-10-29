// sellerbot/src/utils/reportTextYest.js
// Единая точка формирования "общего отчёта за вчера" (одним сообщением)
// Формат — как в старом. Есть: Заказы/Выручка, Выкуп/Маржа, Возвраты, Отмены,
// Расходы на рекламу (Performance API), ДРР, CTR, СВД.

const oz = require('../services/ozon');
const { getYesterdayISO } = require('../utils/dates');

// пробуем подключить Performance API-обёртку
let perf = null;
try { perf = require('../services/performanceApi'); } catch { perf = null; }

// ---------- helpers ----------
const esc = (s='') =>
  String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmtMoney = (n) => (Math.round(Number(n) || 0)).toLocaleString('ru-RU');
const fmtInt   = (n) => (Math.round(Number(n) || 0)).toLocaleString('ru-RU');
const fmtPct   = (n) => (n == null || !isFinite(n))
  ? null
  : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + '%';

// единый вывод строки с "шт. и ₽" или "нет"
function lineCountRub(label, count, sum) {
  const c = Number(count) || 0;
  const s = Number(sum)   || 0;
  if (c === 0 && s === 0) return `${label}: нет`;
  return `${label}: ${fmtInt(c)} шт. на ${fmtMoney(s)}₽`;
}

async function safeCall(fn, fallback, args) {
  if (typeof fn !== 'function') return fallback;
  try { return await fn(args); } catch { return fallback; }
}

// есть ли колонка в таблице
async function hasColumn(db, table, column) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

// получаем отслеживаемые SKU пользователя; если tracked нет — берём все SKU
async function getTrackedSkus(db, chatId) {
  const trackedExists = await hasColumn(db, 'shop_products', 'tracked');
  const sqlBase = `
    SELECT sp.sku::bigint AS sku
      FROM shop_products sp
      JOIN shops s ON s.id = sp.shop_id
      JOIN users u ON u.id = s.user_id
     WHERE u.chat_id = $1
  `;
  const sql = trackedExists ? `${sqlBase} AND sp.tracked = TRUE` : sqlBase;
  const r = await db.query(sql, [chatId]);
  return (r.rows || []).map(x => Number(x.sku)).filter(Number.isFinite);
}

// унифицированный запрос к Ozon — ищем доступный метод
async function ozRequest({ client_id, api_key, endpoint, body }) {
  try {
    const oz = require('../services/ozon');
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
    return null;
  }
}

// /v3/finance/transaction/totals → агрегаты за день
async function getFinanceTotals({ client_id, api_key, date_from, date_to }) {
  const body = {
    date: { from: date_from, to: date_to },
    posting_number: '',
    transaction_type: 'all',
  };
  const resp = await ozRequest({
    client_id, api_key,
    endpoint: '/v3/finance/transaction/totals',
    body,
  });
  return resp?.result || null;
}

// Сумма «расходов» БЕЗ sale_commission (как в /report)
function sumExpensesFromTotalsExCommission(totals) {
  if (!totals || typeof totals !== 'object') return 0;
  const fields = [
    // 'sale_commission',   // исключаем
    'processing_and_delivery',
    'refunds_and_cancellations',
    'services_amount',
    'compensation_amount',
    'money_transfer',
    'others_amount',
  ];
  let s = 0;
  for (const k of fields) {
    const v = Number(totals[k] || 0);
    if (!Number.isFinite(v)) continue;
    s += Math.abs(v);
  }
  return Math.round(s * 100) / 100;
}

// ===== себестоимости из БД (как в /report) =====
async function getCostsMapFromDB(db, chatId) {
  try {
    if (!db || !chatId) return new Map();
    const sql = `
      SELECT sp.sku::bigint AS sku, COALESCE(sp.net, 0)::numeric AS net
        FROM shop_products sp
        JOIN shops s  ON s.id = sp.shop_id
        JOIN users u  ON u.id = s.user_id
       WHERE u.chat_id = $1
    `;
    const r = await db.query(sql, [chatId]);
    const map = new Map();
    for (const row of (r.rows || [])) {
      const sku = Number(row.sku);
      const net = Number(row.net) || 0;
      if (Number.isFinite(sku)) map.set(sku, net);
    }
    return map;
  } catch {
    return new Map();
  }
}
function normalizeSkuFilter(trackedSkus) {
  if (!trackedSkus) return null;
  if (Array.isArray(trackedSkus)) return trackedSkus.map(Number).filter(Number.isFinite);
  if (typeof trackedSkus === 'string') {
    return trackedSkus.split(/[,\s]+/).map(Number).filter(Number.isFinite);
  }
  if (typeof trackedSkus === 'number') return [trackedSkus];
  return null;
}

// ===== выкупы из /v3/finance/transaction/list (как в /report, берём amount>0) =====
async function getBuyoutsFromList({
  client_id, api_key, date_from, date_to, trackedSkus = null, db = null, chatId = null,
}) {
  let count = 0;
  let amount = 0;     // ₽
  let buyoutCost = 0; // ₽ себестоимость

  const skuFilterArray = normalizeSkuFilter(trackedSkus);
  const skuFilter = skuFilterArray ? new Set(skuFilterArray) : null;

  const costsMap = await getCostsMapFromDB(db, chatId); // sku -> net

  const itemMatchesFilter = (items) => {
    if (!skuFilter) return true;
    if (!Array.isArray(items) || !items.length) return false;
    for (const it of items) {
      const skuNum = Number(it?.sku);
      if (skuFilter.has(skuNum)) return true;
    }
    return false;
  };

  let page = 1;
  const page_size = 1000;

  while (true) {
    const data = await ozRequest({
      client_id, api_key, endpoint: '/v3/finance/transaction/list',
      body: {
        filter: {
          date: { from: date_from, to: date_to },
          operation_type: [],
          posting_number: '',
          transaction_type: 'all',
        },
        page, page_size,
      },
    });

    const ops = data?.result?.operations || [];
    if (!ops.length) break;

    for (const op of ops) {
      if (op?.type !== 'orders' || op?.operation_type_name !== 'Доставка покупателю') continue;

      const items = Array.isArray(op?.items) ? op.items : [];
      if (!itemMatchesFilter(items)) continue;

      const amt = Number(op?.amount ?? 0); // важно: берём amount (как в /report)
      if (amt > 0) {
        count += 1;
        amount += amt;
        // себестоимость — по всем позициям
        for (const it of items) {
          const skuNum = Number(it?.sku) || 0;
          if (!skuNum) continue;
          if (skuFilter && !skuFilter.has(skuNum)) continue;
          const net = Number(costsMap.get(skuNum) || 0);
          if (Number.isFinite(net)) buyoutCost += net;
        }
      }
    }

    if (ops.length < page_size) break;
    page += 1;
  }

  return { count, amount, buyoutCost };
}

// ===== Возвраты/Отмены из /v1/returns/list (как в /report) =====
// форма body: { filter: { logistic_return_date: { time_from, time_to } }, limit: 500, last_id }
function isoToSecondZ(iso) {
  if (!iso) return iso;
  const i = iso.indexOf('.');
  const base = i > 0 ? iso.slice(0, i) : iso.replace(/Z?$/, '');
  return `${base}Z`;
}
async function getReturnsAndCancellations({
  client_id, api_key, date_from, date_to, trackedSkus = null,
}) {
  const time_from = isoToSecondZ(date_from); // YYYY-MM-DDTHH:MM:SSZ
  const time_to   = isoToSecondZ(date_to);   // YYYY-MM-DDTHH:MM:SSZ

  const trackedSet = Array.isArray(trackedSkus) && trackedSkus.length
    ? new Set(trackedSkus.map(Number))
    : null;

  let cancelCount = 0, cancelSum = 0;
  let returnCount = 0, returnSum = 0;

  const limit = 500;
  let last_id = 0;

  const amountFromProduct = (pr = {}) => {
    const q = Number(pr?.quantity || 0) || 1;
    const noComm = Number(pr?.price_without_commission?.price || 0);
    const raw    = Number(pr?.price?.price || 0);
    const unit   = noComm > 0 ? noComm : raw;
    return (Number.isFinite(unit) ? unit : 0) * q;
  };
  const qtyFromProduct = (pr = {}) => {
    const q = Number(pr?.quantity || 0);
    return Number.isFinite(q) && q > 0 ? q : 1;
  };
  const passesSkuFilter = (pr = {}) => {
    if (!trackedSet) return true;
    const sku = Number(pr?.sku || pr?.product_id || 0);
    return trackedSet.has(sku);
  };

  for (let page = 1; page <= 500; page++) {
    const body = {
      filter: { logistic_return_date: { time_from, time_to } },
      limit,
      last_id,
    };

    const data = await ozRequest({
      client_id, api_key, endpoint: '/v1/returns/list', body,
    });

    const list = Array.isArray(data?.returns) ? data.returns : [];
    if (!list.length) break;

    for (const ret of list) {
      const t = String(ret?.type || '').trim();
      const pr = ret?.product || {};
      if (!passesSkuFilter(pr)) continue;

      const amt = amountFromProduct(pr);
      const qty = qtyFromProduct(pr);

      if (t === 'ClientReturn') {
        returnCount += qty;
        returnSum   += amt;
      } else if (t === 'Cancellation') {
        cancelCount += qty;
        cancelSum   += amt;
      }

      // курсор last_id — берём максимальный
      if (typeof ret?.id === 'number' && ret.id > last_id) last_id = ret.id;
    }

    const hasNext = Boolean(data?.has_next);
    if (!hasNext) break;
  }

  return {
    returnsCount: Math.round(returnCount),
    returnsSum: Math.round(returnSum * 100) / 100,
    cancelsCount: Math.round(cancelCount),
    cancelsSum: Math.round(cancelSum * 100) / 100,
  };
}

// Перфоманс-креды магазина (последний магазин пользователя) — ИМЕНА ПОЛЕЙ КАК В СХЕМЕ
async function getPerformanceCreds(db, chatId) {
  const q = await db.query(
    `
    SELECT
      s.perf_client_id     AS client_id,
      s.perf_client_secret AS client_secret
    FROM shops s
    JOIN users u ON u.id = s.user_id
    WHERE u.chat_id = $1
    ORDER BY s.created_at DESC NULLS LAST, s.id DESC
    LIMIT 1
    `,
    [chatId]
  );
  if (!q.rowCount) return null;
  const row = q.rows[0];
  if (!row.client_id || !row.client_secret) return null;
  return { client_id: row.client_id, client_secret: row.client_secret };
}

// Расход за дату через разные возможные методы
async function getAdSpendForDate(creds, dateISO) {
  if (!perf || !creds) return null;

  // основной путь — из твоего performanceApi.js
  if (typeof perf.getCampaignDailyStatsTotals === 'function') {
    const r = await safeCall(perf.getCampaignDailyStatsTotals, null, {
      client_id: creds.client_id, client_secret: creds.client_secret, date: dateISO,
    });
    if (r && (r.spent != null || r.spend != null || r.moneySpent != null)) {
      return Number(r.spent ?? r.spend ?? r.moneySpent) || 0;
    }
  }

  // запасные варианты
  if (typeof perf.getDailySpend === 'function') {
    const v = await safeCall(perf.getDailySpend, null, {
      client_id: creds.client_id, client_secret: creds.client_secret, date: dateISO,
    });
    if (v != null) return Number(v) || 0;
  }
  if (typeof perf.getAdSpend === 'function') {
    const v = await safeCall(perf.getAdSpend, null, {
      client_id: creds.client_id, client_secret: creds.client_secret, date: dateISO,
    });
    if (v != null) return Number(v) || 0;
  }
  if (typeof perf.getSummary === 'function') {
    const r = await safeCall(perf.getSummary, null, {
      client_id: creds.client_id, client_secret: creds.client_secret,
      date_from: dateISO, date_to: dateISO,
    });
    const v = r?.spend ?? r?.expense ?? r?.total ?? null;
    if (v != null) return Number(v) || 0;
  }
  if (typeof perf.getStats === 'function') {
    const r = await safeCall(perf.getStats, null, {
      client_id: creds.client_id, client_secret: creds.client_secret,
      date_from: dateISO, date_to: dateISO,
    });
    if (Array.isArray(r) && r.length) {
      const v = r[0]?.spend ?? r[0]?.expense ?? r[0]?.total ?? null;
      if (v != null) return Number(v) || 0;
    }
  }
  return null;
}

// CTR за дату = (клики / показы) * 100
async function getCtrForDate(creds, dateISO) {
  if (!perf || !creds) return null;

  // основной путь — totals за день
  if (typeof perf.getCampaignDailyStatsTotals === 'function') {
    const r = await safeCall(perf.getCampaignDailyStatsTotals, null, {
      client_id: creds.client_id, client_secret: creds.client_secret, date: dateISO,
    });
    if (r) {
      const clicks = Number(
        r.clicks ?? r.click ?? r.totalClicks ?? r.click_count ?? r.clicksCount ?? 0
      );
      const imps = Number(
        r.impressions ?? r.shows ?? r.views ?? r.impressions_count ?? r.show_count ?? 0
      );
      if (imps > 0) return (clicks / imps) * 100;
    }
  }

  // запасные
  if (typeof perf.getSummary === 'function') {
    const r = await safeCall(perf.getSummary, null, {
      client_id: creds.client_id, client_secret: creds.client_secret,
      date_from: dateISO, date_to: dateISO,
    });
    if (r) {
      const clicks = Number(r.clicks ?? r.click ?? r.totalClicks ?? 0);
      const imps   = Number(r.impressions ?? r.shows ?? r.views ?? r.totalShows ?? 0);
      if (imps > 0) return (clicks / imps) * 100;
    }
  }
  if (typeof perf.getStats === 'function') {
    const arr = await safeCall(perf.getStats, null, {
      client_id: creds.client_id, client_secret: creds.client_secret,
      date_from: dateISO, date_to: dateISO,
    });
    if (Array.isArray(arr) && arr.length) {
      let clicks = 0, imps = 0;
      for (const row of arr) {
        clicks += Number(row?.clicks ?? row?.click ?? 0);
        imps   += Number(row?.impressions ?? row?.shows ?? row?.views ?? 0);
      }
      if (imps > 0) return (clicks / imps) * 100;
    }
  }
  return null;
}

// СОИНВЕСТ: средний % по отслеживаемым SKU
async function fetchSoinvestAvg({ client_id, api_key, trackedSkus }) {
  if (!Array.isArray(trackedSkus) || !trackedSkus.length) return null;
  const trackedSet = new Set(trackedSkus.map(Number).filter(Number.isFinite));

  // 1) sku -> product_id
  const skuToPid = new Map();
  let cursor = '';
  for (let i = 0; i < 50; i++) {
    const resp = await ozRequest({
      client_id, api_key,
      endpoint: '/v4/product/info/stocks',
      body: { cursor, filter: { visibility: 'ALL' }, limit: 100 },
    });
    const items = resp?.result?.items || resp?.items || [];
    for (const it of items) {
      const pid = Number(it?.product_id || it?.id || 0);
      const stocks = Array.isArray(it?.stocks) ? it.stocks : [];
      for (const st of stocks) {
        const sku = Number(st?.sku || 0);
        if (Number.isFinite(sku) && trackedSet.has(sku) && Number.isFinite(pid)) {
          skuToPid.set(sku, pid);
        }
      }
    }
    const next = resp?.result?.cursor ?? resp?.cursor ?? '';
    cursor = typeof next === 'string' ? next : '';
    if (!cursor) break;
    if (skuToPid.size >= trackedSet.size) break;
  }

  const productIds = Array.from(new Set([...skuToPid.values()])).filter(Number.isFinite);
  if (!productIds.length) return null;

  // 2) цены по product_id
  const pcts = [];
  for (let i = 0; i < productIds.length; i += 100) {
    const part = productIds.slice(i, i + 100).map(String);
    let next = '';
    for (let page = 0; page < 20; page++) {
      const resp = await ozRequest({
        client_id, api_key,
        endpoint: '/v5/product/info/prices',
        body: { cursor: next, filter: { product_id: part, visibility: 'ALL' }, limit: 100 },
      });
      const items = resp?.result?.items || resp?.items || [];
      for (const it of items) {
        const mp  = Number(it?.price?.marketing_price ?? 0);
        const msp = Number(it?.price?.marketing_seller_price ?? 0);
        if (msp > 0 && mp > 0 && mp <= msp) {
          const pct = (1 - mp / msp) * 100;
          if (Number.isFinite(pct)) pcts.push(pct);
        }
      }
      next = resp?.result?.cursor ?? resp?.cursor ?? '';
      if (!next) break;
    }
  }

  if (!pcts.length) return null;
  const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  return Math.round(avg);
}

// СВД за дату (в часах)
async function getSvdHoursForDate({ client_id, api_key }, dateISO, ctx = {}) {
  const from = `${dateISO}T00:00:00.000Z`;
  const to   = `${dateISO}T23:59:59.999Z`;

  const asHours = (v) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return null;
    return Math.round(x < 24 ? x * 24 : x);
  };

  // Вариант A
  if (typeof oz.getAverageDeliveryTimeDays === 'function') {
    const r = await safeCall(
      oz.getAverageDeliveryTimeDays,
      null,
      { client_id, api_key, date_from: from, date_to: to }
    );

    if (r != null) {
      if (typeof r === 'number') {
        const h = asHours(r);
        if (h != null) return h;
      }
      if (typeof r === 'object') {
        const h =
          asHours(r.avgDeliveryHours) ??
          asHours(r.avg_hours) ??
          asHours(r.avgHours);
        if (h != null) return h;

        const d =
          asHours(r.avgDeliveryDays) ??
          asHours(r.avg_days) ??
          asHours(r.days);
        if (d != null) return d;
      }
    }
  }

  // Вариант B
  if (typeof oz.getDeliveryBuyoutStats === 'function') {
    const st = await safeCall(
      oz.getDeliveryBuyoutStats,
      null,
      { client_id, api_key, date_from: from, date_to: to, db: ctx.db, chatId: ctx.chatId }
    );
    if (st && typeof st === 'object') {
      const h =
        asHours(st.avgDeliveryHours) ??
        asHours(st.avg_hours) ??
        asHours(st.avg_hours_total) ??
        asHours(st.avg_delivery_hours);
      if (h != null) return h;

      const d =
        asHours(st.avgDeliveryDays) ??
        asHours(st.avg_days) ??
        asHours(st.avg_delivery_days);
      if (d != null) return d;
    }
  }

  return null;
}

// --- thresholds from ENV with defaults ---
function getThresholdNum(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}
const TH = {
  drrHigh:       getThresholdNum('DRR_HIGH', 10),         // %
  ctrLow:        getThresholdNum('CTR_LOW', 2.5),         // %
  coinvestLow:   getThresholdNum('COINVEST_LOW', 10),     // %
  svdHighHours:  getThresholdNum('SVD_HIGH_HOURS', 29),   // hours
};

/////////////////////////////////////////////////////////////////////////
/**
 * Сбор текста "вчера" одним блоком.
 * API/логика выкупа, возвратов и маржи — как в /report.
 */
async function makeYesterdaySummaryText(user, ctx = {}) {
  const date = getYesterdayISO();                 // YYYY-MM-DD (Europe/Moscow)
  const from = `${date}T00:00:00.000Z`;
  const to   = `${date}T23:59:59.999Z`;

  const client_id = user.client_id;
  const api_key   = user.seller_api;

  // Заказы/выручка (как было)
  let revenue = 0, orderedUnits = 0;
  const analyticsRes = await safeCall(
    oz.getOzonReportFiltered, [0, 0],
    { client_id, api_key, date, metrics: ['revenue','ordered_units'] }
  );
  if (Array.isArray(analyticsRes)) {
    revenue = Number(analyticsRes[0] || 0);
    orderedUnits = Number(analyticsRes[1] || 0);
  } else if (analyticsRes && typeof analyticsRes === 'object') {
    revenue = Number(analyticsRes.revenue || 0);
    orderedUnits = Number(analyticsRes.ordered_units || 0);
  }

  // Возвраты и Отмены — как в /report, через /v1/returns/list
  const rcn = await getReturnsAndCancellations({
    client_id, api_key, date_from: from, date_to: to
  });
  const returnsCount = Number(rcn?.returnsCount || 0);
  const returnsSum   = Number(rcn?.returnsSum   || 0);
  const cancelsCount = Number(rcn?.cancelsCount || 0);
  const cancelsSum   = Number(rcn?.cancelsSum   || 0);

  // Выкуп (шт. и ₽) + себестоимость — как в /report, через /v3/finance/transaction/list
  const buy = await getBuyoutsFromList({
    client_id, api_key, date_from: from, date_to: to, db: ctx.db, chatId: ctx.chatId
  });
  const buyoutCount  = Number(buy?.count || 0);
  const buyoutAmount = Number(buy?.amount || 0);
  const buyoutCost   = Number(buy?.buyoutCost || 0);

  // Финансовая часть (totals) — только РАСХОДЫ БЕЗ sale_commission (как в /report)
  const totals = await getFinanceTotals({ client_id, api_key, date_from: from, date_to: to });
  const expenses = sumExpensesFromTotalsExCommission(totals);

  // Маржа (как в /report):
  // margin = buyoutAmount − expenses(excl sale_commission) − returnsSum(ClientReturn) − buyoutCost
  const margin = Math.round((buyoutAmount - expenses - returnsSum - buyoutCost) * 100) / 100;

  // (опционально) отладка
  if (process.env.DEBUG_YEST === '1') {
    console.log('[yesterday-summary]', {
      date, from, to,
      orderedUnits, revenue,
      returnsCount, returnsSum,
      cancelsCount, cancelsSum,
      buyoutCount, buyoutAmount, buyoutCost,
      totals_raw: totals,
      expenses_excl_sale_commission: expenses,
      margin,
    });
  }

  // СВД (в часах) + иконка по порогу
  const svdHours = await getSvdHoursForDate(
    { client_id, api_key }, date, { db: ctx.db, chatId: ctx.chatId }
  );
  const svdIcon = (svdHours != null && svdHours > TH.svdHighHours) ? '🔺' : '▫️';

  // Расходы на рекламу (Performance API)
  let adSpendRaw = null;
  let adSpendText = ' -';
  const perfCreds = ctx.db && ctx.chatId ? await getPerformanceCreds(ctx.db, ctx.chatId) : null;
  if (perfCreds) {
    const spend = await getAdSpendForDate(perfCreds, date);
    if (spend != null) {
      adSpendRaw = Number(spend) || 0;
      adSpendText = `${fmtMoney(adSpendRaw)}₽`;
    }
  }

  // ДРР
  const drrVal  = (adSpendRaw != null && revenue > 0) ? (adSpendRaw / revenue) * 100 : null;
  const drrText = (drrVal != null) ? fmtPct(drrVal) : ' -';
  const drrIcon = (drrVal != null && drrVal > TH.drrHigh) ? '🔺' : '▫️';

  // CTR
  const ctrVal  = perfCreds ? await getCtrForDate(perfCreds, date) : null;
  const ctrText = (ctrVal != null) ? fmtPct(ctrVal) : ' -';
  const ctrIcon = (ctrVal != null && ctrVal < TH.ctrLow) ? '🔻' : '▫️';

  // СОИНВЕСТ
  let coinvestVal = null;
  let coinvestText = '—';
  let coinvestIcon = '▫️';
  if (ctx.db && ctx.chatId) {
    const trackedSkus = await getTrackedSkus(ctx.db, ctx.chatId);
    if (trackedSkus.length) {
      const avg = await fetchSoinvestAvg({ client_id, api_key, trackedSkus });
      if (avg != null) {
        coinvestVal  = Number(avg);
        coinvestText = `${Math.round(coinvestVal)}%`;
        coinvestIcon = (coinvestVal < TH.coinvestLow) ? '🔻' : '▫️';
      }
    }
  }

  // --- формируем lines (с логикой "нет") ---
  const lines = [
    `🏪 Магазин: ${user.shop_name || '—'}`,
    ` - - - - `,
    `📆 Общий отчёт за: ${date}`,
    ` - - - - `,
    lineCountRub('📦 Заказы', orderedUnits, revenue),
    ` - - - - `,
    lineCountRub('📦 Выкуплено', buyoutCount, buyoutAmount),
    ` - - - - `,
    lineCountRub('📦 Возвраты', returnsCount, returnsSum),
    ` - - - - `,
    lineCountRub('📦 Отмены', cancelsCount, cancelsSum),
    ` - - - - `,
    `▫️ Расходы на рекламу:  ${adSpendText}`,
    `${drrIcon} Д.Р.Р:  ${drrText}`,
    `${ctrIcon} CTR:  ${ctrText}`,
    `${coinvestIcon} Соинвест: ${coinvestText}`,
    `${svdIcon} СВД: ${svdHours != null ? `${svdHours} ч.` : ' -'}`,
    ` - - - - `,
    `💰 Маржа: ${fmtMoney(margin)}₽`,
    ` - - - - `,
  ];

  return lines.map(l => `<code>${esc(l)}</code>`).join('\n');
}

module.exports = { makeYesterdaySummaryText };
