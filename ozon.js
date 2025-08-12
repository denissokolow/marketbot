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
  let totalCount = 0;
  let totalAmount = 0; // из accruals_for_sale > 0
  let buyoutCost = 0;

  const COSTS = {
    2260596905: 300,
    2262027895: 500,
    2583172589: 1300
  };

  let page = 1;
  const page_size = 1000;

  while (true) {
    const data = await ozonApiRequest({
      client_id,
      api_key,
      endpoint: '/v3/finance/transaction/list',
      body: {
        filter: {
          date: { from: date_from, to: date_to },
          operation_type: [],
          posting_number: '',
          transaction_type: 'all',
        },
        page,
        page_size,
      },
    });

    const ops = data?.result?.operations || [];
    if (!ops.length) break;

    for (const op of ops) {
      if (op?.type === 'orders' && op?.operation_type_name === 'Доставка покупателю') {
        const acc = Number(op?.accruals_for_sale ?? 0);

        // временный вывод для отладки
        console.log(`Операция ${op.operation_id || '(без id)'}: accruals_for_sale=${acc}`);

        if (acc > 0) {
          totalCount += 1;
          totalAmount += acc;
          console.log(`✅ Засчитано в "выкуплено на сумму": +${acc}`);
        } else {
          console.log(`⏩ Пропущено (не положительное значение)`);
        }

        if (Array.isArray(op?.items)) {
          for (const item of op.items) {
            const cost = COSTS[item?.sku];
            if (cost) {
              buyoutCost += cost;
              console.log(`💰 Себестоимость +${cost} по SKU ${item?.sku}`);
            }
          }
        }
      }
    }

    if (ops.length < page_size) break;
    page += 1;
  }

  console.log(`--- Итог по getDeliveryBuyoutStats ---`);
  console.log(`Выкуплено товаров: ${totalCount}`);
  console.log(`Выкуплено на сумму: ${totalAmount}`);
  console.log(`Себестоимость: ${buyoutCost}`);

  return { totalCount, totalAmount, buyoutCost };
}


// Получение buyoutAmount и profit по /v3/finance/transaction/totals
async function getBuyoutAndProfit({ client_id, api_key, date_from, date_to, buyoutCost, buyoutAmount }) {
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

  const t = data.result || {};
  const sale_commission            = Number(t.sale_commission || 0);
  const processing_and_delivery    = Number(t.processing_and_delivery || 0);
  const refunds_and_cancellations  = Number(t.refunds_and_cancellations || 0);
  const services_amount            = Number(t.services_amount || 0);
  const compensation_amount        = Number(t.compensation_amount || 0);
  const money_transfer             = Number(t.money_transfer || 0);
  const others_amount              = Number(t.others_amount || 0);

  // ВАЖНО: прибыль считаем из buyoutAmount (stats.totalAmount), а не из totals.accruals_for_sale
  const profit =
      (Number(buyoutAmount) || 0)
    + sale_commission
    + processing_and_delivery
    + refunds_and_cancellations
    + services_amount
    + compensation_amount
    + money_transfer
    + others_amount
    - (Number(buyoutCost) || 0);

  // Логи для контроля
  console.log('--- Финансовые данные для расчёта прибыли ---');
  console.log('buyoutAmount (из /list):', buyoutAmount);
  console.log('sale_commission:', sale_commission);
  console.log('processing_and_delivery:', processing_and_delivery);
  console.log('refunds_and_cancellations:', refunds_and_cancellations);
  console.log('services_amount:', services_amount);
  console.log('compensation_amount:', compensation_amount);
  console.log('money_transfer:', money_transfer);
  console.log('others_amount:', others_amount);
  console.log('buyoutCost (себестоимость):', buyoutCost);
  console.log('Итого прибыль:', profit);

  return { buyoutAmount, profit, services_amount };
}

module.exports = {
  getOzonReport,
  getReturnsCount,
  getReturnsSum,
  formatMoney,
  getDeliveryBuyoutStats,
  getBuyoutAndProfit
};



