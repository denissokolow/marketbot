const axios = require('axios');

function formatMoney(num) {
  if (num == null || isNaN(num)) return '-';
  return Number(num).toLocaleString('ru-RU');
}

async function ozonApiRequest({ client_id, api_key, endpoint, body }) {
  const url = `https://api-seller.ozon.ru${endpoint}`;
  const headers = {
    "Client-Id": client_id,
    "Api-Key": api_key,
    "Content-Type": "application/json"
  };
  const res = await axios.post(url, body, { headers });
  return res.data;
}

async function getOzonReport({ client_id, api_key, date, metrics, shop_name = '' }) {
  const data = await ozonApiRequest({
    client_id,
    api_key,
    endpoint: '/v1/analytics/data',
    body: {
      date_from: date,
      date_to: date,
      metrics,
      dimension: ["day"],
      filters: [],
      limit: 1,
      offset: 0
    }
  });

  if (!data.result.data.length) {
    return `🏪 Магазин: *${shop_name || "Неизвестно"}*\n📅 Отчет за ${date}\n\nНет данных за этот день.`;
  }

  const values = data.result.data[0].metrics;
  return values;
}

// Готовый форматированный отчет для today
async function getTodayReport({ client_id, api_key, date, shop_name }) {
  const metrics = ["revenue", "ordered_units"];
  const values = await getOzonReport({ client_id, api_key, date, metrics, shop_name });
  return `🏪 Магазин: *${shop_name || "Неизвестно"}*\n\n` +
    `🕒 Отчет за *${date}*\n\n` +
    `💰 Заказано на сумму: ${formatMoney(values[0])}₽\n` +
    `📦 Заказано товаров: ${values[1] ?? '-'}\n`;
}

// Для yesterday
async function getYesterdayReport({ client_id, api_key, date, shop_name }) {
  const metrics = ["revenue", "ordered_units", "returns_sum", "cancellations_sum"];
  const values = await getOzonReport({ client_id, api_key, date, metrics, shop_name });
  return `🏪 Магазин: *${shop_name || "Неизвестно"}*\n\n` +
    `🕒 Отчет за *${date}*\n\n` +
    `💰 Заказано на сумму: ${formatMoney(values[0])}₽\n` +
    `📦 Заказано товаров: ${values[1] ?? '-'}\n` +
    `🔄 Возвраты: ${values[2] ?? '-'}\n` +
    `❌ Отмены: ${values[3] ?? '-'}\n`;
}

module.exports = {
  getTodayReport,
  getYesterdayReport,
  ozonApiRequest, // вдруг понадобится для кастомных вызовов
};
