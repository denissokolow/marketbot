// services/ozon/analytics.js
const { ozonApiRequest } = require('./api');
const { normalizeSkuFilter } = require('./utils');

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

  const items = Array.isArray(data?.result?.items) ? data.result.items
               : Array.isArray(data?.items)        ? data.items
               : [];

  const out = new Map(); // sku -> sum
  for (const it of items) {
    const skuNum = Number(it?.sku || it?.offer_id || 0);
    if (!Number.isFinite(skuNum)) continue;

    let sum = 0;
    if (Array.isArray(it?.warehouses)) {
      for (const w of it.warehouses) {
        const n = Number(w?.available_stock_count ?? 0);
        if (Number.isFinite(n)) sum += n;
      }
    }

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
  fetchStocksPositiveBySku,
  getOzonReportFiltered,
  getAverageDeliveryTimeDays,
  getStocksSumBySkus,
  getOrderedBySkuMap,
};
