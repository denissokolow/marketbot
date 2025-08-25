// utils/reportText.js
const {
  getOzonReportFiltered,
  getReturnsCountFiltered,
  getReturnsSumFiltered,
  getDeliveryBuyoutStats,
  getBuyoutAndProfit,
  getAverageDeliveryTimeDays, // <- функция, делающая POST /v1/analytics/average-delivery-time/summary и возвращающая число дней
  formatMoney,
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

// Выравнивание по правому краю (моноширинный)
function padRight(str, width = 8) {
  const v = String(str);
  const spaces = Math.max(0, width - v.length);
  return ' '.repeat(spaces) + v;
}

// Формат c 2 знаками после запятой (запятая в ru-RU)
function format2(num) {
  if (num == null || !isFinite(num)) return '-';
  return Number(num).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Собирает текст отчёта за дату.
 * opts:
 *  - trackedSkus: Set<number> | number[] — фильтр по SKU
 *  - hideAds: boolean — если true, не выводить «Расходы на рекламу / Д.Р.Р. / CTR / СВД»
 *  - db: pg client (для себестоимости из tracked_products.net)
 *  - chatId: number (для выборки себестоимости по пользователю)
 */
async function makeReportText(user, date, opts = {}) {
  const from = `${date}T00:00:00.000Z`;
  const to   = `${date}T23:59:59.999Z`;

  const trackedSkus = opts.trackedSkus || null;
  const hideAds     = !!opts.hideAds;
  const db          = opts.db || null;
  const chatId      = opts.chatId || null;

  // 1) Заказы (фильтр по SKU)
  const metrics = await getOzonReportFiltered({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date,
    metrics: ['revenue', 'ordered_units'],
    trackedSkus,
  });

  const revenueOrdered = Number(metrics?.[0] || 0);
  const orderedUnits   = Number(metrics?.[1] || 0);

  // 2) Возвраты (фильтр по SKU)
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

  // 3) Выкупы (фильтр по SKU; себестоимость из tracked_products.net через db/chatId)
  const stats = await getDeliveryBuyoutStats({
    client_id:  user.client_id,
    api_key:    user.seller_api,
    date_from:  from,
    date_to:    to,
    trackedSkus,
    db,
    chatId,
  });

  // 4) Суммарные итоги (прибыль считаетcя на базе buyoutAmount из /list)
  const { buyoutAmount, profit, services_amount } = await getBuyoutAndProfit({
    client_id:  user.client_id,
    api_key:    user.seller_api,
    date_from:  from,
    date_to:    to,
    buyoutCost: stats.buyoutCost,
    buyoutAmount: stats.totalAmount,
  });

  // --- РЕКЛАМА: Performance API ---
  let adSpendPerf = null; // ₽
  let ctrPerf     = null; // %
  let drrPerf     = null; // %
  // --- СВД (среднее время доставки, дни) ---
  let svdDaysInt  = null;

  if (!hideAds) {
    // 4.1 Performance (CTR, расходы, ДРР от perf)
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

      if (perfId && perfSecret) {
        const { views, clicks, spent } = await getCampaignDailyStatsTotals({
          client_id: perfId,
          client_secret: perfSecret,
          date, // YYYY-MM-DD
        });

        adSpendPerf = spent; // ₽
        ctrPerf     = views > 0 ? (clicks / views) * 100 : null;
        drrPerf     = revenueOrdered > 0 ? (spent / revenueOrdered) * 100 : null;
      }
    } catch (e) {
      console.error('[makeReportText] Performance API error:', e?.response?.data || e.message);
    }

    // 4.2 СВД (дни, округляем до целого без знаков после запятой)
    try {
      const svd = await getAverageDeliveryTimeDays({
        client_id: user.client_id,
        api_key:   user.seller_api,
        date, // отчет за конкретный день
      });
      if (svd != null && isFinite(svd)) {
        svdDaysInt = Math.round(Number(svd));
      }
    } catch (e) {
      console.error('[makeReportText] SVD error:', e?.response?.data || e.message);
    }
  }

  // Формируем текст (каждую строку будем печатать в <code>...</code>)
  const lines = [];
  lines.push(`🏪 Магазин:  ${padRight(user.shop_name || 'Неизвестно', 0)}`);
  lines.push('');
  lines.push(`📆 Отчёт за:  ${padRight(date, 0)}`);
  lines.push('');
  lines.push(`📦 Заказано товаров:  ${padRight(orderedUnits, 2)}`);
  lines.push(`💸 Заказано на сумму:  ${padRight(`${formatMoney(revenueOrdered)}₽`, 2)}`);
  lines.push('');
  lines.push(`📦 Выкуплено товаров:  ${padRight(stats.totalCount, 2)}`);
  lines.push(`💸 Выкуплено на сумму:  ${padRight(`${formatMoney(buyoutAmount)}₽`, 2)}`);
  lines.push(`💸 Себестоимость выкупов:  ${padRight(`${formatMoney(stats.buyoutCost)}₽`, 2)}`);
  lines.push('');
  lines.push(`📦 Возвраты:  ${padRight(returnsCount, 2)}`);
  lines.push(`💸 Возвраты на сумму:  ${padRight(`${formatMoney(returnsSum)}₽`, 2)}`);
  lines.push('');

  if (!hideAds) {
    const adSpendLine = adSpendPerf == null ? '-' : `${formatMoney(adSpendPerf)}₽`;
    const drrLine     = drrPerf == null     ? '-' : `${format2(drrPerf)}%`;
    const ctrLine     = ctrPerf == null     ? '-' : `${format2(ctrPerf)}%`;
    const svdLine     = svdDaysInt == null  ? '-' : `${svdDaysInt.toLocaleString('ru-RU')} дн.`;

    lines.push(`💸 Расходы на рекламу:  ${padRight(adSpendLine, 2)}`);
    lines.push(`💸 Д.Р.Р:  ${padRight(drrLine, 2)}`);
    lines.push(`💸 CTR:  ${padRight(ctrLine, 2)}`);
    lines.push('');
    lines.push(`📦 СВД:  ${padRight(svdLine, 2)}`);
    lines.push('');
    lines.push(`💰 Прибыль:  ${padRight(`${formatMoney(profit)}₽`, 2)}`);
    lines.push('');
  }

  // Возвращаем без <pre>: каждая строка в <code>...</code> (моноширинный, без голубого фона)
  const html = lines.map(line => `<code>${esc(line)}</code>`).join('\n');
  return html;
}

async function makeTodayReportText(user, opts = {}) {
  const date = getTodayISO();
  return makeReportText(user, date, { ...(opts || {}), hideAds: true });
}

async function makeYesterdayReportText(user, opts = {}) {
  const date = getYesterdayISO();
  return makeReportText(user, date, { ...(opts || {}), hideAds: false });
}

module.exports = {
  makeTodayReportText,
  makeYesterdayReportText,
};
