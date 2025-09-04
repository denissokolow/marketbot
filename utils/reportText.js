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
  const trackedSkus = opts.trackedSkus || null;

  // 1) Разбивка по выкупам (то, что уже было)
  const rows = await getSalesBreakdownBySku({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date_from: from,
    date_to:   to,
    trackedSkus,
  });

  if (!rows.length) {
    return '<code>Данных по позициям нет.</code>';
  }

  // 2) Остатки — одним батчем на все найденные SKU
  const uniqueSkus = Array.from(new Set(rows.map(r => Number(r.sku)).filter(Number.isFinite)));
  let stockMap = new Map();
  try {
    stockMap = await getStocksSumBySkus({
      client_id: user.client_id,
      api_key:   user.seller_api,
      skus: uniqueSkus,
    });
  } catch (e) {
    console.error('[makeSkuBreakdownText] stocks error:', e?.response?.data || e.message);
  }

  // 3) Заказано/Заказано на сумму — по вчерашней дате и по SKU
  let orderedMap = new Map();
  try {
    orderedMap = await getOrderedBySkuMap({
      client_id: user.client_id,
      api_key:   user.seller_api,
      date,            // YYYY-MM-DD (вчера)
      trackedSkus,     // опционально ограничиваем отслеживаемыми
    });
  } catch (e) {
    console.error('[makeSkuBreakdownText] ordered map error:', e?.response?.data || e.message);
  }

  const out = [];
  rows.forEach((r, idx) => {
    const skuNum = Number(r.sku);
    const stock  = stockMap.get(skuNum) ?? 0;

    const ord    = orderedMap.get(skuNum) || { ordered: 0, revenue: 0 };
    const ordQty = Number(ord.ordered) || 0;
    const ordSum = Number(ord.revenue) || 0;
    out.push('<code> - - - - </code>');
    out.push(`<code>🔹 ${esc(firstWord(r.name))} (${r.sku})</code>`);
    
    out.push(`<code>📦 Заказано: ${ordQty.toLocaleString('ru-RU')} шт.</code>`);
    out.push(`<code>💸 Заказано на сумму: ${formatMoney(ordSum)}₽</code>`);
    out.push(`<code>📦 Выкуплено: ${Number(r.count).toLocaleString('ru-RU')} шт.</code>`);
    out.push(`<code>💸 Выкуплено на сумму: ${formatMoney(r.amount)}₽</code>`);
    out.push(`<code>📦 Остаток на складе: ${Number(stock).toLocaleString('ru-RU')} шт.</code>`);
  });

  return out.join('\n'); // отправлять с parse_mode: 'HTML'
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
