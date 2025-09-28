// utils/reportText.js
const {
  getOzonReportFiltered,
  getReturnsCountFiltered,
  getReturnsSumFiltered,
  getDeliveryBuyoutStats,
  getBuyoutAndProfit,
  getSalesBreakdownBySku,
  formatMoney,
  getStocksSumBySkus,
  getOrderedBySkuMap
} = require('../ozon');

const { ozonApiRequest } = require('../services/ozon/api');
const { getPerSkuStatsFromDaily, getCampaignDailyStatsTotals } = require('../services/performanceApi');
const { getTodayISO, getYesterdayISO } = require('./utils');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- ENV пороги ----------
const YEST_RETURNS_WARN_GT = Number(process.env.YEST_RETURNS_WARN_GT ?? 0); // Возвраты > → ❗
const YEST_BRAK_WARN_GT    = Number(process.env.YEST_BRAK_WARN_GT ?? 0);    // Брак > → ❗
const YEST_STOCK_WARN_LT   = Number(process.env.YEST_STOCK_WARN_LT ?? 10);  // Остаток < → ❗
const MTD_DRR_WARN_GT      = Number(process.env.MTD_DRR_WARN_GT ?? 10);     // Д.Р.Р. > → ❗ (и 🔺 в первом сообщении)
const MTD_CTR_WARN_LT      = Number(process.env.MTD_CTR_WARN_LT ?? 2.5);    // CTR < → 🔻

// Новые пороги (для первого сообщения)
const YEST_SOINVEST_WARN_LT = Number(process.env.YEST_SOINVEST_WARN_LT ?? 10); // Соинвест < → 🔺
const YEST_SVD_WARN_GT      = Number(process.env.YEST_SVD_WARN_GT ?? 29);      // СВД > → 🔺

// --------------------------------- Вспомогательные ---------------------------------
async function getOrderedBySkuMapSafe({ client_id, api_key, date, trackedSkus }) {
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await getOrderedBySkuMap({ client_id, api_key, date, trackedSkus });
    } catch (e) {
      const http = e?.response?.status;
      const code = e?.response?.data?.code;
      const msg  = String(e?.response?.data?.message || e?.message || '').toLowerCase();
      const isRate = http === 429 || code === 8 || msg.includes('rate limit');
      const is5xx  = http >= 500 && http < 600;
      if (!isRate && !is5xx) throw e;
      if (attempt >= MAX_RETRIES) throw e;
      const base = 300 * Math.pow(2, attempt);
      const jitter = Math.floor(Math.random() * 200);
      const ms = Math.min(5000, base + jitter);
      await sleep(ms);
    }
  }
  return new Map();
}

async function getStocksSumBySkusChunked({ client_id, api_key, skus, chunk = 900 }) {
  if (!Array.isArray(skus) || !skus.length) return new Map();
  const out = new Map();
  for (let i = 0; i < skus.length; i += chunk) {
    const part = skus.slice(i, i + chunk);
    try {
      const m = await getStocksSumBySkus({ client_id, api_key, skus: part });
      for (const [k, v] of m.entries()) out.set(k, v);
    } catch (e) {
      console.error('[makeSkuBreakdownText] stocks error:', e?.response?.data || e.message);
    }
  }
  return out;
}

async function getTitlesMapFromDB(db, chatId) {
  if (!db || !chatId) return new Map();
  const sql = `
    SELECT sp.sku::bigint AS sku, COALESCE(sp.title, '') AS title
    FROM shop_products sp
    JOIN shops s ON s.id = sp.shop_id
    WHERE s.chat_id = $1
  `;
  const r = await db.query(sql, [chatId]);
  const map = new Map();
  for (const row of (r.rows || [])) {
    const sku = Number(row.sku);
    if (Number.isFinite(sku)) map.set(sku, row.title || '');
  }
  return map;
}

// HTML-экранирование
function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Формат с 2 знаками после запятой
function format2(num) {
  if (num == null || !isFinite(num)) return '-';
  return Number(num).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + '%';
}

// Первое слово из названия
function firstWord(s = '') {
  return String(s).trim().split(/\s+/)[0] || '';
}

// «в названии причины возврата есть "брак"»
const includesBrak = (s) => typeof s === 'string' && s.toLowerCase().includes('брак');

// --------- API helpers: СВД и Соинвест ---------

// СВД (Среднее Время Доставки): POST /v1/analytics/average-delivery-time
async function fetchAverageDeliveryTime({ client_id, api_key }) {
  try {
    const resp = await ozonApiRequest({
      client_id, api_key,
      endpoint: '/v1/analytics/average-delivery-time',
      body: {
        delivery_schema: 'ALL',
        supply_period: 'FOUR_WEEKS',
      },
    });
    const val =
      Number(resp?.result?.total?.average_delivery_time) ||
      Number(resp?.total?.average_delivery_time) || null;
    return Number.isFinite(val) ? Math.round(val) : null; // отображаем целым числом часов
  } catch (e) {
    console.error('[fetchAverageDeliveryTime] error:', e?.response?.data || e.message);
    return null;
  }
}

// Соинвест (средний % по отслеживаемым): v4 stocks -> v5 prices
async function fetchSoinvestAvg({ client_id, api_key, trackedSkus }) {
  if (!Array.isArray(trackedSkus) || !trackedSkus.length) return null;
  const trackedSet = new Set(trackedSkus.map(Number).filter(Number.isFinite));

  // 1) sku -> product_id
  const skuToPid = new Map();
  let cursor = '';
  for (let i = 0; i < 50; i++) { // безопасная отсечка по страницам
    const resp = await ozonApiRequest({
      client_id, api_key,
      endpoint: '/v4/product/info/stocks',
      body: {
        cursor,
        filter: { visibility: 'ALL' },
        limit: 100,
      },
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
    // пагинация
    const nextCursor = resp?.result?.cursor ?? resp?.cursor ?? '';
    cursor = typeof nextCursor === 'string' ? nextCursor : '';
    if (!cursor) break;
    if (skuToPid.size >= trackedSet.size) break; // всё нашли
  }

  const productIds = Array.from(new Set([...skuToPid.values()])).filter(Number.isFinite);
  if (!productIds.length) return null;

  // 2) prices по product_id (чанками)
  const pcts = [];
  for (let i = 0; i < productIds.length; i += 100) {
    const part = productIds.slice(i, i + 100).map(String);
    let next = '';
    for (let page = 0; page < 20; page++) {
      const resp = await ozonApiRequest({
        client_id, api_key,
        endpoint: '/v5/product/info/prices',
        body: {
          cursor: next,
          filter: { product_id: part, visibility: 'ALL' },
          limit: 100,
        },
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
  return Math.round(avg);
}

// --------------------------------- Первое сообщение ---------------------------------
async function makeReportText(user, date, opts = {}) {
  const from = `${date}T00:00:00.000Z`;
  const to   = `${date}T23:59:59.999Z`;

  const trackedSkus = opts.trackedSkus || null;
  const hideAds     = !!opts.hideAds;
  const db          = opts.db || null;
  const chatId      = opts.chatId || null;

  // 1) Заказы
  const metrics = await getOzonReportFiltered({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date,
    metrics: ['revenue', 'ordered_units'],
    trackedSkus,
  });
  const revenueOrdered = Number(metrics?.[0] || 0);
  const orderedUnits   = Number(metrics?.[1] || 0);

  // 2) Возвраты
  const returnsCount = await getReturnsCountFiltered({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date,
    trackedSkus,
  });
  const returnsSum = await getReturnsSumFiltered({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date,
    trackedSkus,
  });

  // 3) Выкупы + себестоимость
  const stats = await getDeliveryBuyoutStats({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date_from: from,
    date_to:   to,
    trackedSkus,
    db,
    chatId,
  });

  // 4) Прибыль
  const { buyoutAmount, profit } = await getBuyoutAndProfit({
    client_id:  user.client_id,
    api_key:    user.seller_api,
    date_from:  from,
    date_to:    to,
    buyoutCost: stats.buyoutCost,
    buyoutAmount: stats.totalAmount,
  });

  // --- реклама Performance (итоги за день для CTR/ДРР) ---
  let adSpendPerf = null, ctrPerf = null, drrPerf = null;
  if (!hideAds) {
    try {
      let perfId = null, perfSecret = null;
      if (db && chatId) {
        const rr = await db.query(
          `SELECT performance_client_id, performance_secret
             FROM shops
            WHERE chat_id = $1
              AND performance_client_id IS NOT NULL
              AND performance_secret IS NOT NULL
            ORDER BY id
            LIMIT 1`,
          [chatId]
        );
        if (rr.rowCount) {
          perfId = rr.rows[0].performance_client_id;
          perfSecret = rr.rows[0].performance_secret;
        }
      }
      if (perfId && perfSecret && typeof getCampaignDailyStatsTotals === 'function') {
        const { views, clicks, spent } = await getCampaignDailyStatsTotals({
          client_id: perfId,
          client_secret: perfSecret,
          date,
        });
        adSpendPerf = spent;
        ctrPerf = views > 0 ? (clicks / views) * 100 : null;
        drrPerf = revenueOrdered > 0 ? (spent / revenueOrdered) * 100 : null;
      }
    } catch (e) {
      console.error('[makeReportText] Performance API error:', e?.response?.data || e.message);
    }
  }

  // --- СВД и Соинвест ---
  const svdAvg = await fetchAverageDeliveryTime({
    client_id: user.client_id,
    api_key:   user.seller_api,
  });

  let soinvestAvg = null;
  try {
    if (Array.isArray(trackedSkus) && trackedSkus.length) {
      soinvestAvg = await fetchSoinvestAvg({
        client_id: user.client_id,
        api_key:   user.seller_api,
        trackedSkus,
      });
    }
  } catch (e) {
    console.error('[makeReportText] soinvest error:', e?.response?.data || e.message);
  }

  // Иконки по порогам
  const drrIcon = (drrPerf != null && drrPerf > MTD_DRR_WARN_GT) ? '🔺' : '▫️';
  const ctrIcon = (ctrPerf != null && ctrPerf < MTD_CTR_WARN_LT) ? '🔻' : '▫️';
  const svdIcon = (svdAvg  != null && svdAvg  > YEST_SVD_WARN_GT) ? '🔺' : '▫️';
  const soiIcon = (soinvestAvg != null && soinvestAvg < YEST_SOINVEST_WARN_LT) ? '🔺' : '▫️';

  // -------- Формирование строк по новому формату --------
  const lines = [];
  lines.push(`🏪 Магазин: ${user.shop_name || 'Неизвестно'}`);
  lines.push(' - - - - ');
  lines.push(`📆 Общий отчёт за: ${date}`);
  lines.push(' - - - - ');
  lines.push(`📦 Заказы: ${Math.round(orderedUnits).toLocaleString('ru-RU')} шт. на ${formatMoney(revenueOrdered)}₽`);
  lines.push(' - - - - ');
  lines.push(`📦 Выкуплено: ${Math.round(stats.totalCount).toLocaleString('ru-RU')} шт. на ${formatMoney(buyoutAmount)}₽`);
  lines.push(' - - - - ');
  lines.push(`📦 Возвраты: ${Math.round(returnsCount).toLocaleString('ru-RU')} шт. на ${formatMoney(returnsSum)}₽`);
  lines.push(' - - - - ');

  if (!hideAds) {
    const adSpendLine = adSpendPerf == null ? '-' : `${formatMoney(adSpendPerf)}₽`;
    const drrLine     = drrPerf == null     ? '-' : format2(drrPerf);
    const ctrLine     = ctrPerf == null     ? '-' : format2(ctrPerf);
    const svdLine     = svdAvg == null      ? '-' : `${svdAvg} ч.`;   // ч. — как договорились
    const soiLine     = soinvestAvg == null ? '-' : `${soinvestAvg}%`;

    lines.push(`▫️ Расходы на рекламу:  ${adSpendLine}`);
    lines.push(`${drrIcon} Д.Р.Р:  ${drrLine}`);
    lines.push(`${ctrIcon} CTR:  ${ctrLine}`);
    lines.push(`${soiIcon} Соинвест: ${soiLine}`);
    lines.push(`${svdIcon} СВД: ${svdLine}`);
    lines.push(' - - - - ');
    lines.push(`💰 Прибыль: ${formatMoney(profit)}₽`);
    lines.push(' - - - - ');
  } else {
    lines.push(`💰 Прибыль: ${formatMoney(profit)}₽`);
    lines.push(' - - - - ');
  }

  return lines.map(line => `<code>${esc(line)}</code>`).join('\n');
}

// ---------------------------- ВСПОМОГАТЕЛЬНОЕ: возвраты/брак за день по SKU ----------------------------
async function getReturnsBySkuForDate({ client_id, api_key, date }) {
  const fromISO = `${date}T00:00:00.000Z`;
  const toISO   = `${date}T23:59:59.999Z`;
  const limit = 500;
  let last_id = 0;
  const counts = new Map();
  const brakCounts = new Map();
  const seen = new Set();

  while (true) {
    const resp = await ozonApiRequest({
      client_id, api_key,
      endpoint: '/v1/returns/list',
      body: { filter: { logistic_return_date: { time_from: fromISO, time_to: toISO } }, limit, last_id },
    });
    const items = resp?.result?.returns || [];
    if (!items.length) break;

    for (const it of items) {
      const sku = Number(it?.sku ?? it?.product?.sku ?? it?.product_id?.sku ?? 0);
      if (!Number.isFinite(sku)) continue;

      const id  = it?.id ?? it?.return_id ?? it?.acceptance_id ?? null;
      const pn  = it?.posting_number || it?.posting?.posting_number || '';
      const idx = it?.item_index ?? it?.item_id ?? it?.index ?? 0;
      const key = id != null ? `id:${id}` : `pn:${pn}|sku:${sku}|idx:${idx}`;
      if (seen.has(key)) continue; seen.add(key);

      const q = Number.isFinite(Number(it?.quantity))
        ? Number(it?.quantity)
        : Number.isFinite(Number(it?.return_count)) ? Number(it?.return_count)
        : Number.isFinite(Number(it?.qty)) ? Number(it?.qty)
        : 1;

      counts.set(sku, (counts.get(sku) || 0) + q);

      const reason = it?.return_reason_name || it?.reason || '';
      if (includesBrak(reason)) {
        brakCounts.set(sku, (brakCounts.get(sku) || 0) + q);
      }
    }

    const next = Number(resp?.result?.last_id ?? 0);
    if (!next || next === last_id) break;
    last_id = next;
  }

  return { counts, brakCounts };
}

// --------------------------------- Второе сообщение ---------------------------------
async function makeSkuBreakdownText(user, date, opts = {}) {
  const from = `${date}T00:00:00.000Z`;
  const to   = `${date}T23:59:59.999Z`;

  // 0) Базовый список SKU — можно ограничить отслеживаемыми
  const trackedSkus = Array.isArray(opts.trackedSkus) && opts.trackedSkus.length
    ? [...new Set(opts.trackedSkus.map(Number).filter(Number.isFinite))]
    : null;

  // 0.1) Названия из БД
  let titleMap = new Map();
  if (opts.db && opts.chatId) {
    try {
      const r = await opts.db.query(`
        SELECT sp.sku::bigint AS sku, COALESCE(sp.title, '') AS title
        FROM shop_products sp
        JOIN shops s ON s.id = sp.shop_id
        WHERE s.chat_id = $1
      `, [opts.chatId]);
      for (const row of (r.rows || [])) {
        const skuNum = Number(row.sku);
        if (Number.isFinite(skuNum)) titleMap.set(skuNum, row.title || '');
      }
    } catch (e) {
      console.error('[makeSkuBreakdownText] title map error:', e?.response?.data || e.message);
    }
  }

  // 1) Выкупы по SKU (finance list)
  const buyouts = await getSalesBreakdownBySku({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date_from: from,
    date_to:   to,
    trackedSkus, // если null — без фильтра
  });
  const buyoutBySku = new Map(); // sku -> { count, amount, name }
  for (const r of buyouts) {
    const sku = Number(r.sku);
    if (!Number.isFinite(sku)) continue;
    buyoutBySku.set(sku, { count: Number(r.count)||0, amount: Number(r.amount)||0, name: r.name || '' });
  }

  // 2) Заказано по SKU (analytics, dimension=sku) — с ретраями
  let orderedMap = new Map();
  try {
    orderedMap = await getOrderedBySkuMapSafe({
      client_id: user.client_id,
      api_key:   user.seller_api,
      date,
      trackedSkus: null, // берём полный срез
    });
  } catch (e) {
    console.error('[makeSkuBreakdownText] ordered map error (after retries):', e?.response?.data || e.message);
  }

  // 3) Возвраты/брак за день по SKU — СНАЧАЛА тянем возвраты
  const { counts: returnsMap, brakCounts: brakMap } = await getReturnsBySkuForDate({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date,
  });

  // 4) Итоговый набор SKU для вывода — объединяем заказы, выкупы И возвраты
  let finalSkus;
  if (trackedSkus && trackedSkus.length) {
    finalSkus = trackedSkus;
  } else {
    const set = new Set([
      ...Array.from(orderedMap.keys()),
      ...Array.from(buyoutBySku.keys()),
      ...Array.from(returnsMap.keys()), // важно: добавить SKU только с возвратами
    ]);
    finalSkus = Array.from(set.values());
  }
  if (!finalSkus.length) return '<code>Данных по позициям нет.</code>';

  // 5) Остатки — уже по финальному набору
  let stockMap = new Map();
  try {
    stockMap = await getStocksSumBySkusChunked({
      client_id: user.client_id,
      api_key:   user.seller_api,
      skus: finalSkus,
    });
  } catch (e) {
    console.error('[makeSkuBreakdownText] stocks error:', e?.response?.data || e.message);
  }

  // 6) Д.Р.Р. за день по SKU через Performance API
  let drrBySku = new Map();
  if (opts.db && opts.chatId && typeof getPerSkuStatsFromDaily === 'function') {
    try {
      const rr = await opts.db.query(`
        SELECT performance_client_id, performance_secret
          FROM shops
         WHERE chat_id = $1
           AND performance_client_id IS NOT NULL
           AND performance_secret IS NOT NULL
         ORDER BY id
         LIMIT 1
      `, [opts.chatId]);

      if (rr.rowCount) {
        const perfId     = rr.rows[0].performance_client_id;
        const perfSecret = rr.rows[0].performance_secret;
        // веса для «все товары» — пропорционально выручке за день
        const allocationWeights = {};
        for (const sku of finalSkus) {
          allocationWeights[sku] = Number(orderedMap.get(sku)?.revenue || 0);
        }
        const perSku = await getPerSkuStatsFromDaily({
          client_id:  perfId,
          client_secret: perfSecret,
          date_from:  date,
          date_to:    date,
          trackedSkus: finalSkus,
          allocationWeights,
        });
        drrBySku = new Map();
        for (const sku of finalSkus) {
          const adv = perSku.get(sku);
          const spent = Number(adv?.spent || 0);
          const rev   = Number(orderedMap.get(sku)?.revenue || 0);
          const drr   = rev > 0 ? (spent / rev) * 100 : null;
          if (drr != null) drrBySku.set(sku, drr);
        }
      }
    } catch (e) {
      console.warn('[makeSkuBreakdownText] Performance daily per-sku error:', e?.response?.status, e?.message);
    }
  }

  // 7) Рендер
  const lines = [];
  lines.push(`<code>📆 Отчёт по товарам за: ${esc(date)}</code>`);
  lines.push('<code> - - - - </code>');

  // Сортировка: по выручке за день
  const orderedSkus = [...new Set(finalSkus)].sort((a,b) => {
    const ra = Number(orderedMap.get(a)?.revenue || 0);
    const rb = Number(orderedMap.get(b)?.revenue || 0);
    return rb - ra || a - b;
  });

  for (const sku of orderedSkus) {
    const ord = orderedMap.get(sku) || { ordered: 0, revenue: 0 };
    const bo  = buyoutBySku.get(sku) || { count: 0, amount: 0, name: '' };
    const stock = Number(stockMap.get(sku) || 0);
    const retQty = Number(returnsMap.get(sku) || 0);
    const brakQty = Number(brakMap.get(sku) || 0);
    const drr = drrBySku.has(sku) ? drrBySku.get(sku) : null;

    const titleFromDb  = titleMap.get(sku) || '';
    const titleFromOps = bo.name || '';
    const displayName  = firstWord(titleFromDb || titleFromOps) || `SKU ${sku}`;

    const returnsIcon = retQty > YEST_RETURNS_WARN_GT ? '❗' : '▫️';
    const brakIcon    = brakQty > YEST_BRAK_WARN_GT    ? '❗' : '▫️';
    const stockIcon   = stock  < YEST_STOCK_WARN_LT    ? '❗' : '▫️';
    const drrIcon     = (drr != null && drr > MTD_DRR_WARN_GT) ? '❗' : '▫️';

    const qtyMoney = (qty, sum) => Number(qty)
      ? `${Math.round(qty).toLocaleString('ru-RU')} шт. на ${formatMoney(sum)}₽`
      : 'нет';
    const qtyOnly = (qty) => Number(qty)
      ? `${Math.round(qty).toLocaleString('ru-RU')} шт.`
      : 'нет';

    lines.push(`<code>📦 ${esc(displayName)} (${sku})</code>`);
    lines.push(`<code>▫️ Заказано: ${qtyMoney(ord.ordered, ord.revenue)}</code>`);
    lines.push(`<code>▫️ Выкуплено: ${qtyMoney(bo.count, bo.amount)}</code>`);
    lines.push(`<code>${returnsIcon} Возвраты: ${qtyOnly(retQty)}</code>`);
    lines.push(`<code>${brakIcon} Брак (в возвратах): ${brakQty ? `${brakQty.toLocaleString('ru-RU')} шт.` : 'нет'}</code>`);
    lines.push(`<code>${stockIcon} Остаток на складе: ${qtyOnly(stock)}</code>`);
    lines.push(`<code>${drrIcon} Д.Р.Р.: ${drr == null ? '—' : format2(drr)}</code>`);
    lines.push('<code> - - - - </code>');
  }

  return lines.join('\n');
}

// ------------------------- Сервисные «сегодня/вчера» -------------------------
async function makeTodayReportText(user, opts = {}) {
  const date = getTodayISO();
  return makeReportText(user, date, { ...(opts || {}), hideAds: true });
}
async function makeYesterdayReportText(user, opts = {}) {
  const date = getYesterdayISO();
  return makeReportText(user, date, { ...(opts || {}), hideAds: false });
}
async function makeYesterdaySkuBreakdownText(user, opts = {}) {
  const date = getYesterdayISO();
  return makeSkuBreakdownText(user, date, opts);
}

module.exports = {
  makeTodayReportText,
  makeYesterdayReportText,
  makeSkuBreakdownText,
  makeYesterdaySkuBreakdownText,
};
