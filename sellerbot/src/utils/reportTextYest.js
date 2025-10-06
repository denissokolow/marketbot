// sellerbot/src/utils/reportTextYest.js
// Единая точка формирования "общего отчёта за вчера" (одним сообщением)
// Формат — как в старом. Есть: Заказы/Выручка, Выкуп/Прибыль, Возвраты,
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

// сумма расходов из totals (берём модуль значений перечисленных полей)
function sumExpensesFromTotals(totals) {
  if (!totals || typeof totals !== 'object') return 0;
  const fields = [
    'sale_commission',
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

// Соинвест (средний % по отслеживаемым SKU): v4 stocks -> v5 prices
async function fetchSoinvestAvg({ client_id, api_key, trackedSkus }) {
  if (!Array.isArray(trackedSkus) || !trackedSkus.length) return null;
  const trackedSet = new Set(trackedSkus.map(Number).filter(Number.isFinite));

  // 1) sku -> product_id
  const skuToPid = new Map();
  let cursor = '';
  for (let i = 0; i < 50; i++) { // безопасная отсечка по страницам
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

  // 2) цены по product_id (чанками)
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
          const pct = (1 - mp / msp) * 100; // доля снижения от цены продавца
          if (Number.isFinite(pct)) pcts.push(pct);
        }
      }
      next = resp?.result?.cursor ?? resp?.cursor ?? '';
      if (!next) break;
    }
  }

  if (!pcts.length) return null;
  const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  return Math.round(avg); // как в старом — целое число процентов
}

// СВД за дату (в часах) с нормализацией: если число < 24 — это дни; иначе — часы.
async function getSvdHoursForDate({ client_id, api_key }, dateISO, ctx = {}) {
  const from = `${dateISO}T00:00:00.000Z`;
  const to   = `${dateISO}T23:59:59.999Z`;

  const asHours = (v) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return null;
    // ключевое правило: маленькие значения (<24) считаем днями, большие — уже часы
    return Math.round(x < 24 ? x * 24 : x);
  };

  // Вариант A: getAverageDeliveryTimeDays — пробуем с диапазоном
  if (typeof oz.getAverageDeliveryTimeDays === 'function') {
    const r = await safeCall(
      oz.getAverageDeliveryTimeDays,
      null,
      { client_id, api_key, date_from: from, date_to: to }
    );

    if (r != null) {
      // числовой ответ
      if (typeof r === 'number') {
        const h = asHours(r);
        if (h != null) return h;
      }
      // объект — пробуем разные поля
      if (typeof r === 'object') {
        // сначала поля с часами
        const h =
          asHours(r.avgDeliveryHours) ??
          asHours(r.avg_hours) ??
          asHours(r.avgHours);
        if (h != null) return h;

        // затем поля с днями (сконвертим, но только если <24)
        const d =
          asHours(r.avgDeliveryDays) ??
          asHours(r.avg_days) ??
          asHours(r.days);
        if (d != null) return d;
      }
    }
  }

  // Вариант B: из getDeliveryBuyoutStats за тот же диапазон
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

  // Ничего подходящего
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
 * Сбор текста "вчера" одним блоком (строго заданный формат).
 * @param {{client_id:string, seller_api:string, shop_name?:string}} user
 * @param {{db?:any, chatId?:number}} [ctx]
 * @returns {Promise<string>} HTML-текст (каждая строка в <code>..</code>)
 */
async function makeYesterdaySummaryText(user, ctx = {}) {
  const date = getYesterdayISO();                 // YYYY-MM-DD (Europe/Moscow)
  const from = `${date}T00:00:00.000Z`;
  const to   = `${date}T23:59:59.999Z`;

  const client_id = user.client_id;
  const api_key   = user.seller_api;

	// Заказы/выручка
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

  // Возвраты
  const returnsCount = await safeCall(oz.getReturnsCountFiltered, 0, { client_id, api_key, date });
  const returnsSum   = await safeCall(oz.getReturnsSumFiltered,   0, { client_id, api_key, date });

  // 3) Выкуп и прибыль (через finance/totals)
const buyoutStats = await safeCall(
  oz.getDeliveryBuyoutStats,
  { totalCount: 0, totalAmount: 0, buyoutCost: 0 },
  { client_id, api_key, date_from: from, date_to: to, db: ctx.db, chatId: ctx.chatId }
);
const buyoutCount = Number(buyoutStats?.totalCount || 0);

// --- Финансы / totals за вчера ---
const totals = await getFinanceTotals({
  client_id, api_key, date_from: from, date_to: to
});
const accrualsForSale = Number(totals?.accruals_for_sale || 0);   // «выкуплено на сумму», ₽
const expensesTotals  = sumExpensesFromTotals(totals);            // все расходы, ₽

// --- Прибыль (вчера) = выкупная выручка − расходы − сумма возвратов ---
const profitFinal = Math.round(
  (accrualsForSale - expensesTotals - Number(returnsSum || 0)) * 100
) / 100;

// (опционально) отладка
if (process.env.DEBUG_YEST === '1') {
  console.log('[yesterday-finance-totals]', {
    date, from, to,
    returnsCount, returnsSum,
    buyoutCount,
    totals_raw: totals,
    accrualsForSale, expensesTotals, profitFinal
  });
}

 // СВД (строго за вчера, в часах) + иконка по порогу
const svdHours = await getSvdHoursForDate(
  { client_id, api_key },
  date,
  { db: ctx.db, chatId: ctx.chatId }
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

// ДРР = (Расходы / Заказы в ₽) * 100  + иконка по порогу
const drrVal  = (adSpendRaw != null && revenue > 0) ? (adSpendRaw / revenue) * 100 : null;
const drrText = (drrVal != null) ? fmtPct(drrVal) : ' -';
const drrIcon = (drrVal != null && drrVal > TH.drrHigh) ? '🔺' : '▫️';

// CTR за вчера + иконка по порогу
const ctrVal  = perfCreds ? await getCtrForDate(perfCreds, date) : null;
const ctrText = (ctrVal != null) ? fmtPct(ctrVal) : ' -';
const ctrIcon = (ctrVal != null && ctrVal < TH.ctrLow) ? '🔻' : '▫️';

// СОИНВЕСТ: средний % по отслеживаемым SKU (как в старом) + иконка по порогу
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

  // --- далее формируем lines (замени только три строки метрик на версии с иконками) ---
const lines = [
  `🏪 Магазин: ${user.shop_name || '—'}`,
  ` - - - - `,
  `📆 Общий отчёт за: ${date}`,
  ` - - - - `,
  `📦 Заказы: ${fmtInt(orderedUnits)} шт. на ${fmtMoney(revenue)}₽`,
  ` - - - - `,
  `📦 Выкуплено: ${fmtInt(buyoutCount)} шт. на ${fmtMoney(accrualsForSale)}₽`,
  ` - - - - `,
  `📦 Возвраты: ${fmtInt(returnsCount)} шт. на ${fmtMoney(returnsSum)}₽`,
  ` - - - - `,
  `▫️ Расходы на рекламу:  ${adSpendText}`,
  `${drrIcon} Д.Р.Р:  ${drrText}`,
  `${ctrIcon} CTR:  ${ctrText}`,
  `${coinvestIcon} Соинвест: ${coinvestText}`,
  `${svdIcon} СВД: ${svdHours != null ? `${svdHours} ч.` : ' -'}`,
  ` - - - - `,
 `💰 Прибыль: ${fmtMoney(profitFinal)}₽`,
  ` - - - - `,
];

  return lines.map(l => `<code>${esc(l)}</code>`).join('\n');
}

module.exports = { makeYesterdaySummaryText };
