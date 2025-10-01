// src/services/ozon/api.js
const axios = require('axios');
const https = require('https');

// ——— ENV-настройки
const OZON_TIMEOUT_MS    = Number(process.env.OZON_TIMEOUT_MS ?? 45000);
const OZON_GLOBAL_RPS    = Number(process.env.OZON_GLOBAL_RPS ?? 2);
const OZON_CONCURRENCY   = Number(process.env.OZON_CONCURRENCY ?? 2);
const OZON_MAX_RETRIES   = Number(process.env.OZON_MAX_RETRIES ?? 5);
const OZON_BACKOFF_BASE  = Number(process.env.OZON_BACKOFF_BASE_MS ?? 300);

// keep-alive агент — сильно снижает задержки
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const client = axios.create({
  baseURL: 'https://api-seller.ozon.ru',
  timeout: OZON_TIMEOUT_MS,
  httpsAgent,
  headers: { 'Content-Type': 'application/json' },
  validateStatus: (s) => s >= 200 && s < 300,
});

// Что ретраим
function isRetryable(err) {
  const status = err?.response?.status;
  const apiCode = err?.response?.data?.code;
  const sysCode = err?.code;
  const netErr = ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'].includes(sysCode);
  const rate   = status === 429 || apiCode === 8;
  const srv    = status >= 500 && status < 600;
  return netErr || rate || srv;
}

// Простейший token-bucket + ограничение конкуренции
let tokens = OZON_GLOBAL_RPS;
let running = 0;
const q = [];
setInterval(() => { tokens = Math.min(tokens + OZON_GLOBAL_RPS, OZON_GLOBAL_RPS); drain(); }, 1000);

function schedule(taskFn) {
  return new Promise((resolve, reject) => { q.push({ taskFn, resolve, reject }); drain(); });
}
function drain() {
  while (running < OZON_CONCURRENCY && tokens > 0 && q.length) {
    const { taskFn, resolve, reject } = q.shift();
    tokens--; running++;
    taskFn().then(resolve, reject).finally(() => { running--; drain(); });
  }
}

async function ozonApiRequest({ client_id, api_key, endpoint, body, method = 'post' }) {
  const run = async () => {
    for (let attempt = 0; attempt < OZON_MAX_RETRIES; attempt++) {
      try {
        const res = await client.request({
          url: endpoint, method, data: body,
          headers: { 'Client-Id': String(client_id), 'Api-Key': String(api_key) },
        });
        return res.data;
      } catch (err) {
        const last = attempt >= OZON_MAX_RETRIES - 1;
        if (!isRetryable(err) || last) throw err;
        const pause = Math.min(OZON_BACKOFF_BASE * 2 ** attempt + Math.floor(Math.random()*200), 5000);
        await new Promise(r => setTimeout(r, pause));
      }
    }
  };
  return schedule(run);
}

module.exports = { ozonApiRequest };
