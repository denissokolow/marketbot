// services/ozon/index.js
const { ozonApiRequest } = require('./api');
const { formatMoney, normalizeSkuFilter } = require('./utils');
const analytics = require('./analytics');
const returns = require('./returns');
const finance = require('./finance');

module.exports = {
  // было в старом модуле:
  formatMoney,
  ozonApiRequest,
  normalizeSkuFilter,

  // аналитика
  fetchStocksPositiveBySku: analytics.fetchStocksPositiveBySku,
  getOzonReportFiltered: analytics.getOzonReportFiltered,
  getAverageDeliveryTimeDays: analytics.getAverageDeliveryTimeDays,
  getStocksSumBySkus: analytics.getStocksSumBySkus,
  getOrderedBySkuMap: analytics.getOrderedBySkuMap,

  // возвраты
  getReturnsCountFiltered: returns.getReturnsCountFiltered,
  getReturnsSumFiltered: returns.getReturnsSumFiltered,

  // финансы
  getDeliveryBuyoutStats: finance.getDeliveryBuyoutStats,
  getSalesBreakdownBySku: finance.getSalesBreakdownBySku,
  getBuyoutAndProfit: finance.getBuyoutAndProfit,
};

