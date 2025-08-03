const { getOzonReport, getReturnsCount, formatMoney } = require('../ozon');

// Вынеси список метрик для отчета за вчера:
const YESTERDAY_METRICS = ['revenue', 'ordered_units', 'cancellations_sum'];

async function makeYesterdayReportText(user, date) {
  // Получить метрики (revenue, ordered_units, cancellations_sum)
  const metrics = await getOzonReport({
    client_id: user.client_id,
    api_key: user.seller_api,
    date,
    metrics: YESTERDAY_METRICS
  });

  // Получить число возвратов
  const returns = await getReturnsCount({
    client_id: user.client_id,
    api_key: user.seller_api,
    date
  });

  let result = `🏪 Магазин: *${user.shop_name || "Неизвестно"}*\n`;
  result += `📅 Отчет за ${date}\n\n`;
  result += `💰 Заказано на сумму: ${formatMoney(metrics?.[0])}₽\n`;
  result += `📦 Заказано товаров: ${metrics?.[1] ?? '-'}\n`;
  result += `🔄 Возвраты: ${returns}\n`;
  result += `❌ Отмены: ${metrics?.[2] ?? '-'}\n`;

  return result;
}

module.exports = { makeYesterdayReportText };

