const { getOzonReport, getReturnsCount, formatMoney } = require('./ozon');

async function makeYesterdayReportText(user, date) {
  const [metrics, returns] = await Promise.all([
    getOzonReport({
      client_id: user.client_id,
      api_key: user.seller_api,
      date,
      metrics: ["revenue", "ordered_units", "cancellations_sum"]
    }),
    getReturnsCount({
      client_id: user.client_id,
      api_key: user.seller_api,
      date
    })
  ]);
  let result = `🏪 Магазин: *${user.shop_name || "Неизвестно"}*\n\n`;
  result += `📅 Отчет за *${date}*\n\n`;
  result += `💰 Заказано на сумму: *${formatMoney(metrics[0])}₽*\n\n`;
  result += `📦 Заказано товаров: *${metrics[1] ?? '-'}*\n\n`;
  result += `🔄 Возвраты: *${returns}*\n\n`;
  return result;
}
module.exports = { makeYesterdayReportText };
