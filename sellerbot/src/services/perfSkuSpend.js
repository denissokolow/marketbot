// sellerbot/src/services/perfSkuSpend.js
// Берём per-SKU метрики прямо из твоего performanceApi.getPerSkuStatsFromDaily
// и возвращаем Map<sku, spent> с метой для отладки.

const DBG = process.env.DEBUG_PERF_SKU === '1';
const log = (...a) => { if (DBG) console.log('[perf-sku]', ...a); };

/**
 * Получить Map<sku, spend> за конкретную дату, используя твой performanceApi.js
 * @param {{
 *   date: string,                         // 'YYYY-MM-DD'
 *   perfCreds: { client_id: string, client_secret: string }, // для performanceApi
 *   trackedSkus?: number[],               // ограничить расчёт этими SKU (опционально)
 *   allocationWeights?: Record<number, number>, // веса для «все товары» (опционально)
 * }} params
 * @returns {Promise<{ map: Map<number, number>, meta: any }>}
 */
async function getPerSkuSpendByDay(params) {
  const { date, perfCreds, trackedSkus = [], allocationWeights = null } = params || {};
  if (!date) throw new Error('date is required');
  if (!perfCreds?.client_id || !perfCreds?.client_secret) {
    throw new Error('perfCreds.client_id/client_secret are required');
  }

  // вызываем твой модуль напрямую
  const perf = require('./performanceApi');
  if (typeof perf.getPerSkuStatsFromDaily !== 'function') {
    throw new Error('performanceApi.getPerSkuStatsFromDaily is not exported');
  }

  const perSkuStats = await perf.getPerSkuStatsFromDaily({
    client_id: perfCreds.client_id,
    client_secret: perfCreds.client_secret,
    date_from: date,
    date_to: date,
    trackedSkus,
    allocationWeights,
  });

  // perSkuStats: Map<sku, { views, clicks, spent }>
  const map = new Map();
  let total = 0, sample = [];

  const iter = perSkuStats instanceof Map ? perSkuStats.entries() : Object.entries(perSkuStats || {});
  for (const [k, v] of iter) {
    const sku = Number(k);
    const spent = Number(v?.spent ?? 0) || 0;
    if (!Number.isFinite(sku)) continue;
    map.set(sku, spent);
    total += spent;
    if (sample.length < 5) sample.push([sku, spent]);
  }

  const meta = { date, total_spend: total, size: map.size, sample };
  log('result meta:', meta);
  return { map, meta };
}

module.exports = { getPerSkuSpendByDay };
