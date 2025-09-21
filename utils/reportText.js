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

// ---------- ENV пороги для второго сообщения ----------
const YEST_RETURNS_WARN_GT = Number(process.env.YEST_RETURNS_WARN_GT ?? 0); // Возвраты > → ❗
const YEST_BRAK_WARN_GT    = Number(process.env.YEST_BRAK_WARN_GT ?? 0);    // Брак > → ❗
const YEST_STOCK_WARN_LT   = Number(process.env.YEST_STOCK_WARN_LT ?? 10);  // Остаток < → ❗
const MTD_DRR_WARN_GT      = Number(process.env.MTD_DRR_WARN_GT ?? 10);     // Д.Р.Р. > → ❗

// --------------------------------- Вспомогательные ---------------------------------
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

// «в названии причины возврата есть "брак"»
const includesBrak = (s) => typeof s === 'string' && s.toLowerCase().includes('брак');

// --------------------------------- Первое сообщение (без изменений по форме) ---------------------------------
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

  // --- реклама Performance (итоги за день) ---
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

// ---------------------------- ВСПОМОГАТЕЛЬНОЕ: возвраты/брак за день по SKU ----------------------------
async function getReturnsBySkuForDate({ client_id, api_key, date }) {
  const fromISO = `${date}T00:00:00.000Z`;
  const toISO   = `${date}T23:59:59.999Z`;
  const limit = 500;
  let last_id = 0;
  const counts = new Map();     // sku -> qty
  const brakCounts = new Map(); // sku -> qty
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

// --------------------------------- Второе сообщение (обновлённый формат) ---------------------------------
/**
 * Второе сообщение: разбивка по позициям ЗА ВЧЕРА.
 * Формат по требованиям:
 * 📆 Отчёт за:  YYYY-MM-DD
 * 📦 Название (sku)
 * ▫️ Заказано: N шт. на S₽
 * ▫️ Выкуплено: N шт. на S₽
 * ▫️ Возвраты: N шт.   (❗ если > YEST_RETURNS_WARN_GT)
 * ▫️ Брак (в возвратах): N шт. (❗ если > YEST_BRAK_WARN_GT)
 * ▫️ Остаток на складе: N шт.  (❗ если < YEST_STOCK_WARN_LT)
 * ▫️/❗ Д.Р.Р.: X,XX%   (❗ если > MTD_DRR_WARN_GT)
 *  - - - - 
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
  if (!finalSkus.length) return '<code>Данных по позициям нет.</code>';

  // 4) Остатки — батчами
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

  // 5) Возвраты/брак за день по SKU
  const { counts: returnsMap, brakCounts: brakMap } = await getReturnsBySkuForDate({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date,
  });

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
  lines.push(`<code>📆 Отчёт за:  ${esc(date)}</code>`);
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

    // имя: приоритет DB -> из выкупов -> SKU N
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
    lines.push(`<code>${drrIcon} Д.Р.Р.: ${drr == null ? '—' : format2(drr) + '%'}</code>`);
    lines.push(''); // пустая строка как в примере
    lines.push('<code> - - - - </code>');
  }

  return lines.join('\n');
}

// ------------------------- Сервисные «сегодня/вчера» (как было) -------------------------
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
