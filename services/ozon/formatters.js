// services/ozon/formatters.js

// Пример: формат сводки продаж/метрик за период
function formatSalesSummary(data) {
  // TODO: перенесите текущую логику из ozon.js
  // Пример заготовки:
  // return `🗓 ${data.date}\nВыручка: ${toMoney(data.revenue)}\nЗаказы: ${data.orders}\n...`;
  return String(data); // временный заглушка
}

// Полезные утилиты (если они у вас сейчас живут в ozon.js)
function toMoney(x, currency = '₽') {
  if (x == null || Number.isNaN(Number(x))) return `0 ${currency}`;
  const n = Number(x);
  return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ${currency}`;
}

module.exports = {
  formatSalesSummary,
  toMoney,
};
