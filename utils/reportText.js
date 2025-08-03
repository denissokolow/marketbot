// reportText.js

const { getOzonReport, getReturnsCount, formatMoney } = require('../ozon');

// Метрики для отчета за вчера
const YESTERDAY_METRICS = ['revenue', 'ordered_units', 'cancellations_sum'];

// Получение текста отчёта за вчера
async function makeYesterdayReportText(user, date) {
  // Получить метрики из analytics (например: сумма, товары, отмены)
  const metricsArr = await getOzonReport({
    client_id: user.client_id,
    api_key: user.seller_api,
    date,
    metrics: YESTERDAY_METRICS
  });

  // Получить количество возвратов (реальный вызов returns/list)
  const returns = await getReturnsCount({
    client_id: user.client_id,
    api_key: user.seller_api,
    date
  });

  let result = `🏪 Магазин: *${user.shop_name || "Неизвестно"}*\n`;
  result += `📅 Отчет за ${date}\n\n`;
  result += `💰 Заказано на сумму: ${formatMoney(metricsArr?.[0])}₽\n`;
  result += `📦 Заказано товаров: ${metricsArr?.[1] ?? '-'}\n`;
  result += `🔄 Возвраты: ${returns}\n`;
  result += `❌ Отмены: ${metricsArr?.[2] ?? '-'}\n`;

  return result;
}

module.exports = {
  makeYesterdayReportText
};
