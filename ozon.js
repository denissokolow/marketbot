// ozon.js
const axios = require('axios');

/** Денежное форматирование (для вывода) */
function formatMoney(num) {
  if (num == null || isNaN(num)) return '-';
  return Math.round(Number(num)).toLocaleString('ru-RU');
}

// Берём первое слово из названия
function shortName(name = '') {
  return String(name).trim().split(/\s+/)[0] || '';
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

/** Нормализация фильтра по SKU -> массив чисел или null */
function normalizeSkuFilter(trackedSkus) {
  if (!trackedSkus) return null;
  const arr = Array.isArray(trackedSkus) ? trackedSkus : Array.from(trackedSkus);
  const cleaned = arr
    .map(x => Number(String(x).trim()))
    .filter(n => Number.isFinite(n));
  return cleaned.length ? cleaned : null;
}

/** Позитивные остатки, агрегированные по SKU (для первичного наполнения ассортимента) */
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
 * /v1/analytics/data — с фильтром по SKU.
 * Возвращает массив метрик как раньше: [revenue, ordered_units]
 */
async function getOzonReportFiltered({ client_id, api_key, date, metrics, trackedSkus }) {
  const list = normalizeSkuFilter(trackedSkus);

  // Без фильтра — один запрос без filters
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

  // С фильтром — по одному SKU
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
          metrics, // ['revenue','ordered_units']
          dimension: ['day'],
          filters: [
            { key: 'sku', value: String(sku), operator: '=' },
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
  const limit = 500;
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
      console.error('getReturnsCountFiltered error:', e?.response?.status, e?.response?.data || e.message);
      break;
    }

    const arr = Array.isArray(res?.returns) ? res.returns : [];
    if (!arr.length) break;

    for (const r of arr) {
      const sku = Number(r?.product?.sku || r?.sku || 0);
      if (!list || (sku && list.includes(sku))) count += 1;
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
      console.error('getReturnsSumFiltered error:', e?.response?.status, e?.response?.data || e.message);
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

/** Вытянуть карту себестоимостей из tracked_products.net по пользователю (только активные) */
async function getCostsMapFromDB(db, chatId) {
  if (!db || !chatId) return new Map();
  const sql = `
    SELECT tp.sku::bigint AS sku, COALESCE(tp.net, 0)::numeric AS net
    FROM tracked_products tp
    JOIN shops s ON s.id = tp.shop_id
    WHERE s.chat_id = $1
      AND tp.is_active = TRUE
  `;
  const r = await db.query(sql, [chatId]);
  const map = new Map();
  for (const row of (r.rows || [])) {
    const sku = Number(row.sku);
    const net = Number(row.net) || 0;
    if (Number.isFinite(sku)) map.set(sku, net);
  }
  return map;
}

/**
 * Доставка покупателю (из /v3/finance/transaction/list) — агрегаты по выкупам.
 */
async function getDeliveryBuyoutStats({
  client_id, api_key, date_from, date_to, trackedSkus = null, db = null, chatId = null,
}) {
  let totalCount = 0;
  let totalAmount = 0;
  let buyoutCost = 0;

  const skuFilterArray = normalizeSkuFilter(trackedSkus);
  const skuFilter = skuFilterArray ? new Set(skuFilterArray) : null;
  const costsMap = await getCostsMapFromDB(db, chatId); // sku -> net(₽)

  const hasTracked = (items) => {
    if (!skuFilter) return true;
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

      const acc = Number(op?.accruals_for_sale ?? 0);
      if (acc > 0) {
        totalCount += 1;
        totalAmount += acc;
      }

      for (const item of items) {
        const skuNum = Number(item?.sku) || 0;
        if (!skuNum) continue;
        if (skuFilter && !skuFilter.has(skuNum)) continue;
        const net = Number(costsMap.get(skuNum) || 0);
        if (Number.isFinite(net)) buyoutCost += net;
      }
    }

    if (ops.length < page_size) break;
    page += 1;
  }

  return { totalCount, totalAmount, buyoutCost };
}

/**
 * Разбивка продаж по SKU на основе /v3/finance/transaction/list.
 * Возвращает массив [{ sku, name, count, amount }], отсортированный по сумме (desc).
 * Сумму операции распределяем поровну между уникальными SKU, попавшими в операцию.
 */
async function getSalesBreakdownBySku({ client_id, api_key, date_from, date_to, trackedSkus = null }) {
  const skuFilterArray = normalizeSkuFilter(trackedSkus);
  const skuFilter = skuFilterArray ? new Set(skuFilterArray) : null;

  const hasTracked = (items) => {
    if (!skuFilter) return true;
    if (!Array.isArray(items) || !items.length) return false;
    for (const it of items) {
      const skuNum = Number(it?.sku);
      if (skuFilter.has(skuNum)) return true;
    }
    return false;
  };

  const agg = new Map(); // sku -> { sku, name, count, amount }

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
      // интересуют только выкупы
      if (op?.type !== 'orders' || op?.operation_type_name !== 'Доставка покупателю') continue;

      const items = Array.isArray(op?.items) ? op.items : [];
      if (!hasTracked(items)) continue;

      const acc = Number(op?.accruals_for_sale ?? 0);
      if (acc <= 0) continue;

      // посчитаем уникальные SKU в этой операции, прошедшие фильтр
      const uniq = new Map(); // sku -> { name, occurrences }
      for (const it of items) {
        const sku = Number(it?.sku) || 0;
        if (!sku) continue;
        if (skuFilter && !skuFilter.has(sku)) continue;
        const name = (it?.name || '').trim();
        const cur = uniq.get(sku) || { name, occurrences: 0 };
        cur.occurrences += 1;
        if (!cur.name && name) cur.name = name;
        uniq.set(sku, cur);
      }
      if (!uniq.size) continue;

      const share = acc / uniq.size;

      for (const [sku, meta] of uniq.entries()) {
        const cur = agg.get(sku) || { sku, name: meta.name || `SKU ${sku}`, count: 0, amount: 0 };
        cur.count += meta.occurrences;
        cur.amount += share;
        agg.set(sku, cur);
      }
    }

    if (ops.length < page_size) break;
    page += 1;
  }

  return [...agg.values()].sort((a, b) => b.amount - a.amount);
}

/**
 * Итоги (прибыль/реклама).
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

/**
 * Среднее время доставки (СВД) в днях.
 * POST /v1/analytics/average-delivery-time/summary
 */
async function getAverageDeliveryTimeDays({ client_id, api_key }) {
  const data = await ozonApiRequest({
    client_id,
    api_key,
    endpoint: '/v1/analytics/average-delivery-time/summary',
    body: {},
  });

  const v =
    data?.result?.average_delivery_time ??
    data?.average_delivery_time ??
    null;

  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Суммарные остатки по списку SKU.
 * POST /v1/analytics/stocks  { skus: ["2583172589", ...] }
 * Возвращает Map<number, number>: sku -> сумма available_stock_count по всем складам.
 */
async function getStocksSumBySkus({ client_id, api_key, skus }) {
  const list = (Array.isArray(skus) ? skus : []).map(s => String(s)).filter(Boolean);
  if (!list.length) return new Map();

  const data = await ozonApiRequest({
    client_id, api_key,
    endpoint: '/v1/analytics/stocks',
    body: { skus: list },
  });

  // Пытаемся быть совместимыми с разными форматами ответа
  const items = Array.isArray(data?.result?.items) ? data.result.items
               : Array.isArray(data?.items)        ? data.items
               : [];

  const out = new Map(); // sku -> sum
  for (const it of items) {
    const skuNum = Number(it?.sku || it?.offer_id || 0);
    if (!Number.isFinite(skuNum)) continue;

    // Формат 1: warehouses: [{ available_stock_count }]
    let sum = 0;
    if (Array.isArray(it?.warehouses)) {
      for (const w of it.warehouses) {
        const n = Number(w?.available_stock_count ?? 0);
        if (Number.isFinite(n)) sum += n;
      }
    }

    // Формат 2: плоские поля (fallback)
    const direct = Number(it?.available_stock_count ?? it?.free_to_sell ?? 0);
    if (Number.isFinite(direct)) sum += direct;

    out.set(skuNum, (out.get(skuNum) || 0) + sum);
  }

  return out;
}

/**
 * Пересчёт "Заказано" и "Заказано на сумму" по каждому SKU за конкретную дату.
 * Делает POST /v1/analytics/data c dimension ['sku'] и metrics ['revenue','ordered_units'].
 * Возвращает Map<skuNumber, { ordered:number, revenue:number }>
 */
async function getOrderedBySkuMap({ client_id, api_key, date, trackedSkus = null }) {
  // один запрос на дату, агрегирует разрез по SKU
  const resp = await ozonApiRequest({
    client_id,
    api_key,
    endpoint: '/v1/analytics/data',
    body: {
      date_from: date,
      date_to: date,
      metrics: ['revenue', 'ordered_units'],
      dimension: ['sku'],
      limit: 1000,
      offset: 0,
    },
  });

  const rows = Array.isArray(resp?.result?.data) ? resp.result.data
             : Array.isArray(resp?.data)        ? resp.data
             : [];

  const filter = normalizeSkuFilter(trackedSkus);
  const only = filter ? new Set(filter) : null;

  const map = new Map(); // sku -> { ordered, revenue }

  for (const row of rows) {
    // разные варианты представления dimension
    let skuStr =
      row?.dimensions?.[0]?.value ??
      row?.dimensions?.[0]?.id ??
      row?.dimensions?.[0];

    const sku = Number(String(skuStr).trim());
    if (!Number.isFinite(sku)) continue;
    if (only && !only.has(sku)) continue;

    const m = Array.isArray(row?.metrics) ? row.metrics : [];
    const revenue = Number(m?.[0] || 0);
    const ordered = Number(m?.[1] || 0);

    map.set(sku, { ordered, revenue });
  }

  return map;
}

module.exports = {
  formatMoney,
  ozonApiRequest,
  normalizeSkuFilter,
  fetchStocksPositiveBySku,
  getOzonReportFiltered,
  getReturnsCountFiltered,
  getReturnsSumFiltered,
  getDeliveryBuyoutStats,
  getSalesBreakdownBySku,
  getBuyoutAndProfit,
  getAverageDeliveryTimeDays,
  getStocksSumBySkus,
  getOrderedBySkuMap
};
