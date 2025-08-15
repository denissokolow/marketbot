// utils/reportText.js
const {
  getOzonReportFiltered,
  getReturnsCountFiltered,
  getReturnsSumFiltered,
  getDeliveryBuyoutStats,
  getBuyoutAndProfit,
  formatMoney,
} = require('../ozon');
const { getTodayISO, getYesterdayISO } = require('./utils');

// HTML-экранирование
function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Выравнивание по правому краю
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

/**
 * opts:
 *  - trackedSkus: number[]|Set<number>
 *  - hideAds: boolean — скрыть строки по рекламе (для /report_today)
 */
async function makeReportText(user, date, opts = {}) {
  const from = `${date}T00:00:00.000Z`;
  const to   = `${date}T23:59:59.999Z`;

  const trackedSkus = opts.trackedSkus || null;
  const hideAds = !!opts.hideAds;

  // 1) Заказы (С ФИЛЬТРОМ по SKU)
  const [revenueOrdered, orderedUnits] = await getOzonReportFiltered({
    client_id: user.client_id,
    api_key: user.seller_api,
    date,
    metrics: ['revenue', 'ordered_units'],
    trackedSkus,
  });

  // 2) Возвраты (С ФИЛЬТРОМ по SKU)
  const returnsCount = await getReturnsCountFiltered({
    client_id: user.client_id,
    api_key: user.seller_api,
    date,
    trackedSkus,
  });
  const returnsSum   = await getReturnsSumFiltered({
    client_id: user.client_id,
    api_key: user.seller_api,
    date,
    trackedSkus,
  });

  // 3) Выкупы (С ФИЛЬТРОМ по SKU)
  const stats = await getDeliveryBuyoutStats({
    client_id: user.client_id,
    api_key: user.seller_api,
    date_from: from,
    date_to: to,
    trackedSkus,
  });

  // 4) Прибыль/Реклама (buyoutAmount — уже отфильтрован!)
  const { buyoutAmount, profit, services_amount } = await getBuyoutAndProfit({
    client_id: user.client_id,
    api_key: user.seller_api,
    date_from: from,
    date_to: to,
    buyoutCost: stats.buyoutCost,
    buyoutAmount: stats.totalAmount,
  });

  // 5) ДРР (если не скрываем рекламные строки)
  const adSpend = Math.abs(Number(services_amount || 0));
  const drrPercent = revenueOrdered > 0 ? (adSpend / revenueOrdered) * 100 : null;

  // Текст отчёта (моноширинный через <pre>)
  const lines = [];
  lines.push(`🏪 Магазин:  ${padRight(user.shop_name || 'Неизвестно', 0)}`);
  lines.push('');
  lines.push(`📆 Отчёт за:  ${padRight(date, 0)}`);
  lines.push('');
  lines.push(`📦 Заказано товаров:  ${padRight(orderedUnits ?? '-', 2)}`);
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
    lines.push('');
    lines.push(`💸 Расходы на рекламу:  ${padRight(`${formatMoney(adSpend)}₽`, 2)}`);
    lines.push(`💸 Д.Р.Р:  ${padRight(drrPercent == null ? '-' : `${format2(drrPercent)}%`, 2)}`);
    lines.push('');
    lines.push(`💰 Прибыль:  ${padRight(`${formatMoney(profit)}₽`, 2)}`);
    lines.push('_');
  }

  return `<pre>${esc(lines.join('\n'))}</pre>`;
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
