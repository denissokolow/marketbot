const axios = require('axios');
const Bottleneck = require('bottleneck');
const { config } = require('../../config');

const http = axios.create({
  baseURL: 'https://api-seller.ozon.ru',
  timeout: config.ozon.timeoutMs,
});

const limiter = new Bottleneck({
  minTime: Math.ceil(1000 / Math.max(1, config.ozon.globalRps)),
  maxConcurrent: config.ozon.concurrency,
});

/**
 * Универсальный вызов Ozon Seller API
 * @param {string} endpoint - например '/v1/analytics/data'
 * @param {object} body
 * @param {{client_id: string, api_key: string}} creds
 */
async function request(endpoint, body, creds) {
  return limiter.schedule(async () => {
    let attempt = 0, last;
    while (attempt++ <= config.ozon.maxRetries) {
      try {
        const { data } = await http.post(endpoint, body, {
          headers: {
            'Client-Id': creds.client_id,
            'Api-Key': creds.api_key,
            'Content-Type': 'application/json',
          },
        });
        return data;
      } catch (e) {
        last = e;
        if (attempt > config.ozon.maxRetries) break;
        await new Promise(r => setTimeout(r, config.ozon.backoffBaseMs * attempt));
      }
    }
    throw last;
  });
}

module.exports = { request };
