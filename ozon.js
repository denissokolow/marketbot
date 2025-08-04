const axios = require('axios');

// Форматирование денежных значений
function formatMoney(num) {
  if (num == null || isNaN(num)) return '-';
  return Number(num).toLocaleString('ru-RU');
}

// Универсальный вызов Ozon API
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

// Получить метрики analytics/data
async function getOzonReport({ client_id, api_key, date, metrics }) {
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

  if (!data.result.data.length) return null;
  return data.result.data[0].metrics;
}

// Получить количество возвратов за дату
async function getReturnsCount({ client_id, api_key, date }) {
  const res = await ozonApiRequest({
    client_id,
    api_key,
    endpoint: '/v1/returns/list',
    body: {
      filter: {
        logistic_return_date: {
          time_from: `${date}T00:00:00.000Z`,
          time_to:   `${date}T23:59:59.999Z`
        }
      },
      limit: 100,
      offset: 0
    }
  });
  return Array.isArray(res.returns) ? res.returns.length : 0;
}

module.exports = {
  getOzonReport,
  getReturnsCount,
  formatMoney,
};


