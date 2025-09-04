// services/ozon/utils.js

/** Денежное форматирование (для вывода) */
function formatMoney(num) {
  if (num == null || isNaN(num)) return '-';
  return Math.round(Number(num)).toLocaleString('ru-RU');
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

// оставим на будущее: в старом файле было, но наружу не экспортировалось
function shortName(name = '') {
  return String(name).trim().split(/\s+/)[0] || '';
}

module.exports = {
  formatMoney,
  normalizeSkuFilter,
  // shortName — не экспортируем, чтобы не расширять публичное API
};
