// services/ozon/finance.js
const { ozonApiRequest } = require('./api');
const { normalizeSkuFilter } = require('./utils');

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
      if (op?.type !== 'orders' || op?.operation_type_name !== 'Доставка покупателю') continue;

      const items = Array.isArray(op?.items) ? op.items : [];
      if (!hasTracked(items)) continue;

      const acc = Number(op?.accruals_for_sale ?? 0);
      if (acc <= 0) continue;

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

module.exports = {
  getDeliveryBuyoutStats,
  getSalesBreakdownBySku,
  getBuyoutAndProfit,
  // getCostsMapFromDB — внутренний хелпер; по необходимости можно экспортировать
};
