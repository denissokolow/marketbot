// ozon.js
const axios = require('axios');

/** Денежное форматирование */
function formatMoney(num) {
  if (num == null || isNaN(num)) return '-';
  return Math.round(Number(num)).toLocaleString('ru-RU');
}

/** Универсальный POST к Ozon Seller API */
async function ozonApiRequest({ client_id, api_key, endpoint, body }) {
  const url = `https://api-seller.ozon.ru${endpoint}`;
  const headers = {
    'Client-Id': client_id,
    'Api-Key': api_key,
    'Content-Type': 'application/json',
  };
  const res = await axios.post(url, body, {
    headers,
    timeout: 15000,
    baseURL: 'https://api-seller.ozon.ru',
  });
  return res.data;
}

/** Нормализация фильтра по SKU */
function normalizeSkuFilter(trackedSkus) {
  if (!trackedSkus) return null;
  const arr = Array.isArray(trackedSkus) ? trackedSkus : Array.from(trackedSkus);
  const cleaned = arr
    .map(x => Number(String(x).trim()))
    .filter(n => Number.isFinite(n));
  return cleaned.length ? cleaned : null;
}

/** Загрузить карту себестоимости из БД: Map<sku(number) -> net(number≥0)> */
async function loadCostsMap(db, chatId) {
  if (!db || !chatId) return new Map(); // опционально
  const sql = `
    SELECT tp.sku::bigint AS sku, COALESCE(tp.net, 0)::bigint AS net
    FROM tracked_products tp
    JOIN shops s ON s.id = tp.shop_id
    WHERE s.chat_id = $1
      AND tp.is_active = TRUE
  `;
  const r = await db.query(sql, [chatId]);
  const map = new Map();
  for (const row of r.rows || []) {
    const sku = Number(row.sku);
    const net = Math.max(0, Number(row.net) || 0);
    if (Number.isFinite(sku)) map.set(sku, net);
  }
  return map;
}

/**
 * Позитивные остатки, агрегированные по SKU (для первичного наполнения ассортимента)
 * /v1/analytics/manage/stocks
 */
async function fetchStocksPositiveBySku({ client_id, api_key }) {
  const endpoint = '/v1/analytics/manage/stocks';
  const limit = 1000;
  let offset = 0;
  const bySku = new Map();

  while (true) {
    const data = await ozonApiRequest({
      client_id, api_key, endpoint,
      body: { limit, offset },
    });

    const items = Array.isArray(data?.items)
      ? data.items
      : (Array.isArray(data?.result?.items) ? data.result.items : []);
    if (!items.length) break;

    for (const it of items) {
      const sku  = Number(it?.sku);
      const name = it?.name || it?.offer_id || '';
      const qty  = Number(it?.valid_stock_count ?? 0);
      if (!sku || qty <= 0) continue;

      if (bySku.has(sku)) bySku.get(sku).quantity += qty;
      else bySku.set(sku, { sku, title: name, quantity: qty });
    }

    if (items.length < limit) break;
    offset += items.length;
  }

  return [...bySku.values()].sort((a, b) => a.sku - b.sku);
}

/**
 * /v1/analytics/data — С УЧЁТОМ ФИЛЬТРА SKU
 * Оzon API не принимает массив значений для sku (даёт 400),
 * поэтому суммируем метрики по каждому SKU отдельным запросом.
 * Возвращает массив метрик: [revenue, ordered_units]
 */
async function getOzonReportFiltered({ client_id, api_key, date, metrics, trackedSkus }) {
  const list = normalizeSkuFilter(trackedSkus);

  // Без фильтра — обычный запрос
  if (!list) {
    const data = await ozonApiRequest({
      client_id, api_key,
      endpoint: '/v1/analytics/data',
      body: {
        date_from: date,
        date_to: date,
        metrics,
        dimension: ['day'],
        filters: [],
        limit: 1,
        offset: 0,
      },
    });
    if (!data?.result?.data?.length) return [0, 0];
    return data.result.data[0].metrics;
  }

  // С фильтром — суммируем по одному SKU за раз
  let revenue = 0;
  let ordered = 0;

  for (const sku of list) {
    try {
      const resp = await ozonApiRequest({
        client_id, api_key,
        endpoint: '/v1/analytics/data',
        body: {
          date_from: date,
          date_to: date,
          metrics,                 // ['revenue','ordered_units']
          dimension: ['day'],
          filters: [
            { key: 'sku', value: String(sku), operator: '=' }, // один SKU за запрос
          ],
          limit: 1,
          offset: 0,
        },
      });

      const m = resp?.result?.data?.[0]?.metrics;
      if (Array.isArray(m) && m.length >= 2) {
        revenue += Number(m[0] || 0);
        ordered += Number(m[1] || 0);
      }
    } catch (e) {
      console.error('[getOzonReportFiltered] error per SKU', sku, e?.response?.data || e.message);
    }
  }

  return [revenue, ordered];
}

/** Возвраты (кол-во) с фильтром по SKU */
async function getReturnsCountFiltered({ client_id, api_key, date, trackedSkus }) {
  const list = normalizeSkuFilter(trackedSkus);
  const endpoint = '/v1/returns/list';
  const limit = 500; // максимум 500
  let offset = 0;
  let count = 0;

  while (true) {
    let res;
    try {
      res = await ozonApiRequest({
        client_id, api_key, endpoint,
        body: {
          filter: {
            logistic_return_date: {
              time_from: `${date}T00:00:00.000Z`,
              time_to:   `${date}T23:59:59.999Z`,
            },
          },
          limit,
          offset,
        },
      });
    } catch (e) {
      console.error('getReturnsCount error:', e?.response?.status, e?.response?.data || e.message);
      break;
    }

    const arr = Array.isArray(res?.returns) ? res.returns : [];
    if (!arr.length) break;

    for (const r of arr) {
      const sku = Number(r?.product?.sku || r?.sku || 0);
      if (!list || (sku && list.includes(sku))) {
        count += 1;
      }
    }

    if (arr.length < limit) break;
    offset += arr.length;
  }

  return count;
}

/** Возвраты (сумма) с фильтром по SKU */
async function getReturnsSumFiltered({ client_id, api_key, date, trackedSkus }) {
  const list = normalizeSkuFilter(trackedSkus);
  const endpoint = '/v1/returns/list';
  const limit = 500;
  let offset = 0;
  let total = 0;

  while (true) {
    let res;
    try {
      res = await ozonApiRequest({
        client_id, api_key, endpoint,
        body: {
          filter: {
            logistic_return_date: {
              time_from: `${date}T00:00:00.000Z`,
              time_to:   `${date}T23:59:59.999Z`,
            },
          },
          limit,
          offset,
        },
      });
    } catch (e) {
      console.error('getReturnsSum error:', e?.response?.status, e?.response?.data || e.message);
      break;
    }

    const arr = Array.isArray(res?.returns) ? res.returns : [];
    if (!arr.length) break;

    for (const r of arr) {
      const sku = Number(r?.product?.sku || r?.sku || 0);
      if (!list || (sku && list.includes(sku))) {
        total += Number(r?.product?.price?.price || 0);
      }
    }

    if (arr.length < limit) break;
    offset += arr.length;
  }

  return total;
}

/**
 * Доставка покупателю (из /v3/finance/transaction/list) с фильтром по отслеживаемым SKU.
 * totalAmount — сумма ПОЛОЖИТЕЛЬНЫХ accruals_for_sale по включённым операциям.
 * buyoutCost — сумма net по позициям операции (берётся из tracked_products.net; NULL/0 → 0).
 *
 * Доп. параметры (необязательно):
 *  - db, chatId — чтобы подтянуть net из БД. Если не передать, себестоимость = 0.
 */
async function getDeliveryBuyoutStats({
  client_id,
  api_key,
  date_from,
  date_to,
  trackedSkus = null,
  db = null,
  chatId = null,
}) {
  let totalCount = 0;
  let totalAmount = 0;
  let buyoutCost = 0;

  // карта себестоимости из БД: sku -> net
  const costsMap = await loadCostsMap(db, chatId); // пустая Map(), если db/chatId не передали

  const skuFilterArray = normalizeSkuFilter(trackedSkus);
  const skuFilter = skuFilterArray ? new Set(skuFilterArray) : null;
  console.log(`[getDeliveryBuyoutStats] skuFilter = ${skuFilter ? `Set(size=${skuFilter.size})` : 'NONE'}`);

  const hasTracked = (items) => {
    if (!skuFilter) return true; // нет фильтра — берем всё
    if (!Array.isArray(items) || !items.length) return false;
    for (const it of items) {
      const skuNum = Number(it?.sku);
      if (skuFilter.has(skuNum)) return true;
    }
    return false;
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
      if (op?.type !== 'orders' || op?.operation_type_name !== 'Доставка покупателю') continue;

      const items = Array.isArray(op?.items) ? op.items : [];
      const include = hasTracked(items);

      if (!include) continue;

      // Сумма по операции
      const acc = Number(op?.accruals_for_sale ?? 0);
      if (acc > 0) {
        totalCount += 1;
        totalAmount += acc;
      }

      // Себестоимость — из tracked_products.net (NULL/0 → 0)
      for (const item of items) {
        const skuNum = Number(item?.sku);
        if (!skuNum) continue;
        if (skuFilter && !skuFilter.has(skuNum)) continue; // при фильтре учитываем только отслеживаемые
        const net = Number(costsMap.get(skuNum) || 0);
        if (Number.isFinite(net) && net > 0) {
          buyoutCost += net;
        }
      }
    }

    if (ops.length < page_size) break;
    page += 1;
  }

  console.log(`--- Итог по getDeliveryBuyoutStats ---`);
  console.log(`Выкуплено товаров (операций): ${totalCount}`);
  console.log(`Выкуплено на сумму (accruals_for_sale>0): ${totalAmount}`);
  console.log(`Себестоимость (по отслеживаемым позициям): ${buyoutCost}`);

  return { totalCount, totalAmount, buyoutCost };
}

/**
 * Итоги (прибыль/реклама). totals в API не умеет фильтроваться по SKU,
 * поэтому buyoutAmount берём отфильтрованный (из /list), а комиссии/доставка/прочее — как есть.
 */
async function getBuyoutAndProfit({ client_id, api_key, date_from, date_to, buyoutCost, buyoutAmount }) {
  const data = await ozonApiRequest({
    client_id, api_key,
    endpoint: '/v3/finance/transaction/totals',
    body: {
      date: { from: date_from, to: date_to },
      posting_number: '',
      transaction_type: 'all',
    },
  });

  const t = data?.result || {};
  const sale_commission           = Number(t.sale_commission || 0);
  const processing_and_delivery   = Number(t.processing_and_delivery || 0);
  const refunds_and_cancellations = Number(t.refunds_and_cancellations || 0);
  const services_amount           = Number(t.services_amount || 0);
  const compensation_amount       = Number(t.compensation_amount || 0);
  const money_transfer            = Number(t.money_transfer || 0);
  const others_amount             = Number(t.others_amount || 0);

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

  return { buyoutAmount, profit, services_amount };
}

module.exports = {
  formatMoney,
  ozonApiRequest,
  fetchStocksPositiveBySku,
  getOzonReportFiltered,
  getReturnsCountFiltered,
  getReturnsSumFiltered,
  getDeliveryBuyoutStats,
  getBuyoutAndProfit,
};
