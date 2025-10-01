// src/services/ozon/returns.js
const { ozonApiRequest } = require('./api');
const { normalizeSkuFilter } = require('./utils');

/** Возвраты (кол-во) с фильтром по SKU */
async function getReturnsCountFiltered({ client_id, api_key, date, trackedSkus }) {
  const list = normalizeSkuFilter(trackedSkus);
  const endpoint = '/v1/returns/list';
  const limit = 500;
  let offset = 0, count = 0;

  while (true) {
    let res;
    try {
      res = await ozonApiRequest({
        client_id, api_key, endpoint,
        body: { filter: { logistic_return_date: { time_from: `${date}T00:00:00.000Z`, time_to: `${date}T23:59:59.999Z` } }, limit, offset },
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
  let offset = 0, total = 0;

  while (true) {
    let res;
    try {
      res = await ozonApiRequest({
        client_id, api_key, endpoint,
        body: { filter: { logistic_return_date: { time_from: `${date}T00:00:00.000Z`, time_to: `${date}T23:59:59.999Z` } }, limit, offset },
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

module.exports = { getReturnsCountFiltered, getReturnsSumFiltered };
