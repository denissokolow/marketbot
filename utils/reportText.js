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
const { getCampaignDailyStatsTotals } = require('../services/performanceApi');
const { getTodayISO, getYesterdayISO } = require('./utils');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getOrderedBySkuMapSafe({ client_id, api_key, date, trackedSkus }) {
  // безопасные ретраи при rate-limit (code:8 / HTTP 429 / 5xx)
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
      if (!isRate && !is5xx) throw e; // не ретраим нефлэткие ошибки
      if (attempt >= MAX_RETRIES) throw e;
      // экспоненциальный бэкофф с джиттером
      const base = 300 * Math.pow(2, attempt); // 300,600,1200,2400,4800
      const jitter = Math.floor(Math.random() * 200);
      const ms = Math.min(5000, base + jitter);
      // можно логировать при отладке:
      // console.warn('[getOrderedBySkuMapSafe] retry in', ms, 'ms', e?.response?.data || e?.message);
      await sleep(ms);
    }
  }
  return new Map(); // теоретически недостижимо
}

// маленький чанкёр на всякий случай для /v1/analytics/stocks
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

// Выравнивание по правому краю (для моноширинного текста)
function padRight(str, width = 8) {
  const v = String(str);
  const spaces = Math.max(0, width - v.length);
  return ' '.repeat(spaces) + v;
}

// Формат с 2 знаками после запятой
function format2(num) {
  if (num == null || !isFinite(num)) return '-';
  return Number(num).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Первое слово из названия
function firstWord(s = '') {
  return String(s).trim().split(/\s+/)[0] || '';
}

/**
 * Основной отчёт за дату
 * СТИЛЬ: каждая строка в <code>...</code> (моноширинный без подложки)
 */
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
  const { buyoutAmount, profit /*, services_amount*/ } = await getBuyoutAndProfit({
    client_id:  user.client_id,
    api_key:    user.seller_api,
    date_from:  from,
    date_to:    to,
    buyoutCost: stats.buyoutCost,
    buyoutAmount: stats.totalAmount,
  });

  // --- реклама Performance ---
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

  // Формируем строки
  const lines = [];
  lines.push(`🏪 Магазин:  ${padRight(user.shop_name || 'Неизвестно', 0)}`);
  lines.push(' - - - - ');
  lines.push(`📆 Отчёт за:  ${padRight(date, 0)}`);
  lines.push(' - - - - ');
  lines.push(`📦 Заказано товаров:  ${padRight(orderedUnits, 2)} шт.`);
  lines.push(`💸 Заказано на сумму:  ${padRight(`${formatMoney(revenueOrdered)}₽`, 2)}`);
  lines.push(' - - - - ');
  lines.push(`📦 Выкуплено товаров:  ${padRight(stats.totalCount, 2)} шт.`);
  lines.push(`💸 Выкуплено на сумму:  ${padRight(`${formatMoney(buyoutAmount)}₽`, 2)}`);
  lines.push(`💸 Себестоимость выкупов:  ${padRight(`${formatMoney(stats.buyoutCost)}₽`, 2)}`);
  lines.push(' - - - - ');
  lines.push(`📦 Возвраты:  ${padRight(returnsCount, 2)} шт.`);
  lines.push(`💸 Возвраты на сумму:  ${padRight(`${formatMoney(returnsSum)}₽`, 2)}`);
  lines.push(' - - - - ');

  if (!hideAds) {
    const adSpendLine = adSpendPerf == null ? '-' : `${formatMoney(adSpendPerf)}₽`;
    const drrLine     = drrPerf == null     ? '-' : `${format2(drrPerf)}%`;
    const ctrLine     = ctrPerf == null     ? '-' : `${format2(ctrPerf)}%`;
    lines.push(`💸 Расходы на рекламу:  ${padRight(adSpendLine, 2)}`);
    lines.push(`💸 Д.Р.Р:  ${padRight(drrLine, 2)}`);
    lines.push(`💸 CTR:  ${padRight(ctrLine, 2)}`);
    lines.push(' - - - - ');
    lines.push(`💰 Прибыль:  ${padRight(`${formatMoney(profit)}₽`, 2)}`);
    lines.push(' - - - - ');
  }

  // ВОЗВРАЩАЕМ моноширинный БЕЗ подложки (каждая строка в <code>)
  return lines.map(line => `<code>${esc(line)}</code>`).join('\n');
}

/**
 * Второе сообщение: разбивка по позициям
 * СТИЛЬ: каждая строка в <code>...</code> (моноширинный без подложки)
 * Показываем: Заказано, Заказано на сумму (из /v1/analytics/data, dimension=sku),
 *             Выкуплено, Выкуплено на сумму (из /v3/finance/transaction/list),
 *             Остаток на складе (из /v1/analytics/stocks).
 */
async function makeSkuBreakdownText(user, date, opts = {}) {
  const from = `${date}T00:00:00.000Z`;
  const to   = `${date}T23:59:59.999Z`;

  // 0) Базовый список SKU — показываем все отслеживаемые
  const trackedSkus = Array.isArray(opts.trackedSkus) && opts.trackedSkus.length
    ? [...new Set(opts.trackedSkus.map(Number).filter(Number.isFinite))]
    : null;

  // 0.1) Карта названий из БД, чтобы корректно именовать SKU без выкупов
  let titleMap = new Map();
  if (opts.db && opts.chatId) {
    try {
      const r = await opts.db.query(
        `
        SELECT sp.sku::bigint AS sku, COALESCE(sp.title, '') AS title
        FROM shop_products sp
        JOIN shops s ON s.id = sp.shop_id
        WHERE s.chat_id = $1
        `,
        [opts.chatId]
      );
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
    trackedSkus, // если null — без фильтра (но мы всё равно отрисуем только tracked при наличии их)
  });
  const buyoutBySku = new Map(); // sku -> { count, amount, name }
  for (const r of buyouts) {
    const sku = Number(r.sku);
    if (!Number.isFinite(sku)) continue;
    buyoutBySku.set(sku, { count: Number(r.count)||0, amount: Number(r.amount)||0, name: r.name || '' });
  }

  // 2) Заказано по SKU (analytics, dimension=sku) — с ретраями при rate-limit
  let orderedMap = new Map();
  try {
    orderedMap = await getOrderedBySkuMapSafe({
      client_id: user.client_id,
      api_key:   user.seller_api,
      date,
      trackedSkus: null, // берём полный срез, чтобы не терять позиции с заказами
    });
  } catch (e) {
    console.error('[makeSkuBreakdownText] ordered map error (after retries):', e?.response?.data || e.message);
  }

  // 3) Итоговый набор SKU для вывода
  let finalSkus;
  if (trackedSkus && trackedSkus.length) {
    finalSkus = trackedSkus;
  } else {
    const set = new Set([
      ...Array.from(buyoutBySku.keys()),
      ...Array.from(orderedMap.keys()),
    ]);
    finalSkus = Array.from(set.values());
  }

  if (!finalSkus.length) {
    return '<code>Данных по позициям нет.</code>';
  }

  // 4) Остатки — одним батчем (с чанками на всякий)
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

  // 5) Собираем строки. Сортировка: активные вверх, затем «нулевые».
  const rows = finalSkus.map((sku) => {
    const ord = orderedMap.get(sku) || { ordered: 0, revenue: 0 };
    const bo  = buyoutBySku.get(sku) || { count: 0, amount: 0, name: '' };
    const stock = Number(stockMap.get(sku) || 0);

    // приоритет имени: shop_products -> имя из выкупов -> "SKU N"
    const titleFromDb  = titleMap.get(sku) || '';
    const titleFromOps = bo.name || '';
    const displayName  = firstWord(titleFromDb || titleFromOps) || `SKU ${sku}`;

    return {
      sku,
      name: displayName,
      orderedQty: Number(ord.ordered) || 0,
      orderedSum: Number(ord.revenue) || 0,
      buyoutQty:  Number(bo.count) || 0,
      buyoutSum:  Number(bo.amount) || 0,
      stock,
      activeScore: ((Number(bo.amount)||0) > 0 || (Number(ord.revenue)||0) > 0)
        ? (Number(bo.amount)||0) : -1,
    };
  });

  rows.sort((a, b) => {
    if (a.activeScore !== b.activeScore) return b.activeScore - a.activeScore;
    return a.sku - b.sku;
  });

  // 6) Рендер
  const out = [];
  rows.forEach((r) => {
    out.push('<code> - - - - </code>');
    out.push(`<code>🔹 ${esc(r.name)} (${r.sku})</code>`);
    out.push(`<code>📦 Заказано: ${r.orderedQty.toLocaleString('ru-RU')} шт.</code>`);
    out.push(`<code>💸 Заказано на сумму: ${formatMoney(r.orderedSum)}₽</code>`);
    out.push(`<code>📦 Выкуплено: ${r.buyoutQty.toLocaleString('ru-RU')} шт.</code>`);
    out.push(`<code>💸 Выкуплено на сумму: ${formatMoney(r.buyoutSum)}₽</code>`);
    out.push(`<code>📦 Остаток на складе: ${r.stock.toLocaleString('ru-RU')} шт.</code>`);
  });

  return out.join('\n');
}


// Сервисные «сегодня/вчера»
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
