const axios = require('axios');

function formatMoney(num) {
  if (num === undefined || num === null) return '-';
  return Number(num).toLocaleString('ru-RU');
}

async function getOzonReport(client_id, api_key, date, type = 'today', shop_name = '') {
  let metrics = (type === 'today')
    ? ["revenue", "ordered_units"]
    : ["revenue", "ordered_units", "returns_sum", "cancellations_sum"];
  const res = await axios.post(
    'https://api-seller.ozon.ru/v1/analytics/data',
    {
      date_from: date,
      date_to: date,
      metrics,
      dimension: ["day"],
      filters: [],
      limit: 1,
      offset: 0
    },
    {
      headers: {
        "Client-Id": client_id,
        "Api-Key": api_key,
        "Content-Type": "application/json"
      }
    }
  );
  if (!res.data.result.data.length) {
    return `🏪 Магазин: *${shop_name || "Неизвестно"}*\n📅 Отчет за ${date}\n\nНет данных за этот день.`;
  }
  const values = res.data.result.data[0].metrics;
  let result = `🏪 Магазин: *${shop_name || "Неизвестно"}*\n\n`;
  result += `🕒 Отчет за *${date}*\n\n`;
  result += `💰 Заказано на сумму: ${formatMoney(values[0])}₽\n\n`;
  result += `📦 Заказано товаров: ${formatMoney(values[1])}\n`;
  if (type === 'yesterday') {
    result += `🔄 Возвраты: ${formatMoney(values[2])}\n`;
    result += `❌ Отмены: ${formatMoney(values[3])}\n`;
  }
  return result;
}

module.exports = { getOzonReport };
