const { getOzonReport, getReturnsCount, getReturnsSum, getDeliveryBuyoutStats, formatMoney } = require('../ozon');
const { getTodayISO, getYesterdayISO } = require('./utils');

async function makeReportText(user, date, isToday = false) {
  // Даты для запроса в формате ISO + Z
  const from = `${date}T00:00:00.000Z`;
  const to   = `${date}T23:59:59.999Z`;

  // Основные метрики
  const metrics = await getOzonReport({
    client_id: user.client_id,
    api_key: user.seller_api,
    date,
    metrics: ['revenue', 'ordered_units']
  });

  // Возвраты
  const returnsCount = await getReturnsCount({ client_id: user.client_id, api_key: user.seller_api, date });
  const returnsSum = await getReturnsSum({ client_id: user.client_id, api_key: user.seller_api, date });

  // Выкупы (Доставка покупателю)
  const { count: deliveryCount, amount: deliveryAmount } = await getDeliveryBuyoutStats({
    client_id: user.client_id,
    api_key: user.seller_api,
    date_from: from,
    date_to: to
  });

  let result = `🏪 Магазин: *${user.shop_name || "Неизвестно"}*\n`;
  result += `📆 Отчет за ${date}\n\n`;
  result += `💰 Заказано на сумму: *${formatMoney(metrics?.[0])}₽*\n`;
  result += `📦 Заказано товаров: ${metrics?.[1] ?? '-'}\n`;
  result += `💰 Выкуплено: *${deliveryCount}*\n`;
  result += `💸 Выкуплено на сумму: *${formatMoney(deliveryAmount)}₽*\n`;
  result += `🔄 Возвраты: ${returnsCount}\n`;
  result += `🔄 Возвраты на сумму: ${formatMoney(returnsSum)}₽\n`;
  return result;
}

async function makeTodayReportText(user) {
  const date = getTodayISO();
  return await makeReportText(user, date, true);
}

async function makeYesterdayReportText(user) {
  const date = getYesterdayISO();
  return await makeReportText(user, date, false);
}

module.exports = {
  makeTodayReportText,
  makeYesterdayReportText
};


