// Универсальная выборка остатков через /v1/analytics/turnover/stocks
// Пейджит по limit/offset, собирает все items
const { request } = require('./client');

async function fetchAllTurnoverStocks(creds, { limit = 500, offset = 0, maxPages = 200 } = {}) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const data = await request('/v1/analytics/turnover/stocks', { limit, offset }, creds);
    const chunk = (data?.items || data?.result?.items || []);
    if (!Array.isArray(chunk) || chunk.length === 0) break;

    all.push(...chunk);
    if (chunk.length < limit) break;
    offset += limit;
  }
  return all;
}

module.exports = { fetchAllTurnoverStocks };
