// src/services/ozon/utils.js
function formatMoney(num) {
  if (num == null || isNaN(num)) return '-';
  return Math.round(Number(num)).toLocaleString('ru-RU');
}

/** Нормализация фильтра по SKU -> массив чисел или null */
function normalizeSkuFilter(trackedSkus) {
  if (!trackedSkus) return null;
  const arr = Array.isArray(trackedSkus) ? trackedSkus : Array.from(trackedSkus);
  const cleaned = arr.map(x => Number(String(x).trim())).filter(Number.isFinite);
  return cleaned.length ? cleaned : null;
}

module.exports = { formatMoney, normalizeSkuFilter };
