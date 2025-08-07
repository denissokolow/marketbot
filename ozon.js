const axios = require('axios');

// Форматирование денежных значений
function formatMoney(num) {
  if (num == null || isNaN(num)) return '-';
  return Math.round(Number(num)).toLocaleString('ru-RU');
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

// В ozon.js 
async function getDeliveryBuyoutStats({ client_id, api_key, date_from, date_to }) {
  let totalCount = 0, totalAmount = 0, buyoutCost = 0;
  let page = 1, page_size = 1000;
  const COSTS = {
    2260596905: 300,
    2262027895: 500
  };

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

        // Вычисляем себестоимость по каждой item внутри операции
        if (op.items && Array.isArray(op.items)) {
          op.items.forEach(item => {
            if (COSTS[item.sku]) {
              buyoutCost += COSTS[item.sku];
            }
          });
        }
      }
    });

    if (ops.length < page_size) break;
    page++;
  }

  return { totalCount, totalAmount, buyoutCost };
}

// Получение buyoutAmount и profit по /v3/finance/transaction/totals
async function getBuyoutAndProfit({ client_id, api_key, date_from, date_to, buyoutCost }) {
  const data = await ozonApiRequest({
    client_id,
    api_key,
    endpoint: '/v3/finance/transaction/totals',
    body: {
      date: { from: date_from, to: date_to },
      posting_number: "",
      transaction_type: "all"
    }
  });

  const totals = data.result || {};

  const accruals_for_sale = Number(totals.accruals_for_sale || 0);
  const sale_commission = Number(totals.sale_commission || 0);
  const processing_and_delivery = Number(totals.processing_and_delivery || 0);
  const refunds_and_cancellations = Number(totals.refunds_and_cancellations || 0);
  const services_amount = Number(totals.services_amount || 0);
  const compensation_amount = Number(totals.compensation_amount || 0);
  const money_transfer = Number(totals.money_transfer || 0);
  const others_amount = Number(totals.others_amount || 0);

  // Подсчет прибыли по формуле:
  const profit = accruals_for_sale
    + sale_commission
    + processing_and_delivery
    + refunds_and_cancellations
    + services_amount
    + compensation_amount
    + money_transfer
    + others_amount
    - (buyoutCost || 0);

  // === ВРЕМЕННО! Блок для вывода всех значений: ===
  console.log('--- Финансовые данные для расчета прибыли ---');
  console.log('accruals_for_sale:', accruals_for_sale);
  console.log('sale_commission:', sale_commission);
  console.log('processing_and_delivery:', processing_and_delivery);
  console.log('refunds_and_cancellations:', refunds_and_cancellations);
  console.log('services_amount:', services_amount);
  console.log('compensation_amount:', compensation_amount);
  console.log('money_transfer:', money_transfer);
  console.log('others_amount:', others_amount);
  console.log('buyoutCost (себестоимость):', buyoutCost);
  console.log('Итого прибыль:', profit);

  return {
    buyoutAmount: accruals_for_sale,
    profit
  };
}

module.exports = {
  getOzonReport,
  getReturnsCount,
  getReturnsSum,
  formatMoney,
  getDeliveryBuyoutStats,
  getBuyoutAndProfit
};
