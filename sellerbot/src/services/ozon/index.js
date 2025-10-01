// src/services/ozon/index.js
const { formatMoney, normalizeSkuFilter } = require('./utils');
const { ozonApiRequest } = require('./api');
const analytics = require('./analytics');
const returns = require('./returns');
const finance = require('./finance');

module.exports = {
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

