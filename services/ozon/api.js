// services/ozon/api.js
const axios = require('axios');

/** Универсальный POST к Ozon Seller API (как было в ozon.old.js) */
async function ozonApiRequest({ client_id, api_key, endpoint, body }) {
  const url = `https://api-seller.ozon.ru${endpoint}`;
  const headers = {
    'Client-Id': client_id,
    'Api-Key': api_key,
    'Content-Type': 'application/json',
  };
  const res = await axios.post(url, body, {
    headers,
    timeout: 15000,
    baseURL: 'https://api-seller.ozon.ru',
  });
  return res.data;
}

module.exports = { ozonApiRequest };
