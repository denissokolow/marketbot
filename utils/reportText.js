// utils/reportText.js
const {
  getOzonReport,
  getReturnsCount,
  getReturnsSum,
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

async function makeReportText(user, date) {
  const from = `${date}T00:00:00.000Z`;
  const to   = `${date}T23:59:59.999Z`;

  // 1) Заказы
  const metrics = await getOzonReport({
    client_id: user.client_id,
    api_key: user.seller_api,
    date,
    metrics: ['revenue', 'ordered_units'],
  });

  // 2) Возвраты
  const returnsCount = await getReturnsCount({ client_id: user.client_id, api_key: user.seller_api, date });
  const returnsSum = await getReturnsSum({ client_id: user.client_id, api_key: user.seller_api, date });

  // 3) Выкупы
  const stats = await getDeliveryBuyoutStats({
    client_id: user.client_id,
    api_key: user.seller_api,
    date_from: from,
    date_to: to,
  });

  // 4) Выкуплено на сумму + прибыль
  const { buyoutAmount, profit, services_amount } = await getBuyoutAndProfit({
    client_id: user.client_id,
    api_key: user.seller_api,
    date_from: from,
    date_to: to,
    buyoutCost: stats.buyoutCost,
    buyoutAmount: stats.totalAmount // ← из getDeliveryBuyoutStats
  });

  // 5) ДРР = (расходы на рекламу / заказано на сумму) * 100
  const revenueOrdered = Number(metrics?.[0] || 0);
  const adSpend = Math.abs(Number(services_amount || 0));
  const drrPercent = revenueOrdered > 0 ? (adSpend / revenueOrdered) * 100 : null;

  // Собираем в массив строк
  const lines = [];
  lines.push(`🏪 Магазин:  ${padRight(user.shop_name || 'Неизвестно', 0)}`);
  lines.push('');
  lines.push(`📆 Отчёт за:  ${padRight(date, 0)}`);
  lines.push('');
  lines.push(`📦 Заказано товаров:  ${padRight(metrics?.[1] ?? '-', 2)}`);
  lines.push(`💸 Заказано на сумму:  ${padRight(`${formatMoney(revenueOrdered)}₽`, 2)}`);
  lines.push('');
  lines.push(`📦 Выкуплено товаров:  ${padRight(stats.totalCount, 2)}`);
  lines.push(`💸 Выкуплено на сумму:  ${padRight(`${formatMoney(buyoutAmount)}₽`, 2)}`);
  lines.push(`💸 Себестоимость выкупов:  ${padRight(`${formatMoney(stats.buyoutCost)}₽`, 2)}`);
  lines.push(`💰 Прибыль:  ${padRight(`${formatMoney(profit)}₽`, 2)}`);
  lines.push('');
  lines.push(`📦 Возвраты:  ${padRight(returnsCount, 2)}`);
  lines.push(`💸 Возвраты на сумму:  ${padRight(`${formatMoney(returnsSum)}₽`, 2)}`);
  lines.push('');
  lines.push(`💸 Расходы на рекламу:  ${padRight(`${formatMoney(adSpend)}₽`, 2)}`);
  lines.push(`💸 Д.Р.Р:  ${padRight(drrPercent == null ? '-' : `${format2(drrPercent)}%`, 2)}`);

  // Возвращаем всё как <pre>...</pre>
  return `<pre>${esc(lines.join('\n'))}</pre>`;
}

async function makeTodayReportText(user) {
  const date = getTodayISO();
  return makeReportText(user, date);
}

async function makeYesterdayReportText(user) {
  const date = getYesterdayISO();
  return makeReportText(user, date);
}

module.exports = {
  makeTodayReportText,
  makeYesterdayReportText,
};
