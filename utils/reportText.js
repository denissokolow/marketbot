const { getOzonReport, getReturnsCount, getReturnsSum, formatMoney } = require('../ozon');

// Для отчёта за сегодня
async function makeTodayReportText(user, date) {
  const metrics = await getOzonReport({
    client_id: user.client_id,
    api_key: user.seller_api,
    date,
    metrics: ['revenue', 'ordered_units']
  });
  const returnsCount = await getReturnsCount({
    client_id: user.client_id,
    api_key: user.seller_api,
    date
  });
  const returnsSum = await getReturnsSum({
    client_id: user.client_id,
    api_key: user.seller_api,
    date
  });
  let result = `🏪 Магазин: *${user.shop_name || "Неизвестно"}*\n`;
  result += `📆 Отчет за ${date}\n\n`;
  result += `📦 Заказано: ${metrics?.[1] ?? '-'}\n`;
  result += `💸 Заказано на сумму: *${formatMoney(metrics?.[0])}₽*\n`;
  result += `💰 Среднее за месяц: *-*\n\n`;
  result += `💰 Выкуплено: *-*\n`;
  result += `💸 Выкуплено на сумму: *-*\n\n`;
  result += `🔄 Возвраты: ${returnsCount}\n`;
  result += `💸 Возвраты на сумму: *${formatMoney(returnsSum)}₽*\n\n`;
  return result;
}

// Для отчёта за вчера
async function makeYesterdayReportText(user, date) {
  const metrics = await getOzonReport({
    client_id: user.client_id,
    api_key: user.seller_api,
    date,
    metrics: ['revenue', 'ordered_units', 'cancellations_sum']
  });
  const returnsCount = await getReturnsCount({ client_id: user.client_id, api_key: user.seller_api, date });
  const returnsSum = await getReturnsSum({ client_id: user.client_id, api_key: user.seller_api, date });

  let result = `🏪 Магазин: *${user.shop_name || "Неизвестно"}*\n`;
  result += `📆 Отчет за ${date}\n\n`;
  result += `📦 Заказано: ${metrics?.[1] ?? '-'}\n`;
  result += `💸 Заказано на сумму: *${formatMoney(metrics?.[0])}₽*\n`;
  result += `💰 Среднее за месяц: *-*\n\n`;
  result += `💰 Выкуплено: *-*\n`;
  result += `💸 Выкуплено на сумму: *-*\n\n`;
  result += `🔄 Возвраты: ${returnsCount}\n`;
  result += `💸 Возвраты на сумму: *${formatMoney(returnsSum)}₽*\n\n`;
  return result;
}

module.exports = {
  makeTodayReportText,
  makeYesterdayReportText
};

