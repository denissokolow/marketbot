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

async function getReturnsSum({ client_id, api_key, date }) {
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
  if (!Array.isArray(res.returns)) return 0;
  return res.returns.reduce(
    (sum, item) => sum + (item.product?.price?.price || 0),
    0
  );
}

// В utils/ozon.js (или непосредственно в ozon.js)
async function getDeliveryBuyoutStats({ client_id, api_key, date_from, date_to }) {
  let totalCount = 0, totalAmount = 0;
  let page = 1, page_size = 1000;

  while (true) {
    const data = await ozonApiRequest({
      client_id,
      api_key,
      endpoint: '/v3/finance/transaction/list',
      body: {
        filter: {
          date: { from: date_from, to: date_to },
          operation_type: [],
          posting_number: "",
          transaction_type: "all"
        },
        page,
        page_size
      }
    });

    const ops = data.result?.operations || [];
    ops.forEach(op => {
      if (op.operation_type_name === "Доставка покупателю") {
        totalCount++;
        totalAmount += Number(op.amount);
      }
    });

    if (ops.length < page_size) break;
    page++;
  }

  return { count: totalCount, amount: totalAmount };
}

module.exports = { /* ...твои существующие функции..., */ getDeliveryBuyoutStats };


module.exports = {
  getOzonReport,
  getReturnsCount,
  getReturnsSum,
  formatMoney,
  getDeliveryBuyoutStats
};
