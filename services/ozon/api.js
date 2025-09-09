// services/ozon/api.js
// Ozon Seller API: пер-клиентный лимит 2 rps + ретраи при rate limit/сетевых.

const axios = require('axios');
const Bottleneck = require('bottleneck');

// ==== Конфиг через ENV (можно не трогать) ====
const REQUEST_TIMEOUT_MS   = Number(process.env.OZON_REQUEST_TIMEOUT_MS || 20000);

// 2 запроса/сек на client_id (можно поменять через ENV)
const PER_CLIENT_RPS       = Number(process.env.OZON_PER_CLIENT_RPS || 2);

// Ретраи при rate-limit/временных ошибках
const MAX_RETRIES          = Number(process.env.OZON_MAX_RETRIES || 5);
const BACKOFF_BASE_MS      = Number(process.env.OZON_BACKOFF_BASE_MS || 300);
const BACKOFF_MAX_MS       = Number(process.env.OZON_BACKOFF_MAX_MS || 5000);

// (опц.) Глобальная конкуррентность, чтобы не забить сеть/CPU
const GLOBAL_MAX_CONCURRENCY = Number(process.env.OZON_GLOBAL_MAX_CONCURRENCY || 4);

// ==== Лимитеры ====
// Глобально ограничим одновременные HTTP (не rps, а concurrency)
const globalLimiter = new Bottleneck({ maxConcurrent: GLOBAL_MAX_CONCURRENCY });

// Группа помагазинных лимитеров: на КАЖДЫЙ client_id — 2 токена/сек
const perClientGroup = new Bottleneck.Group({
  maxConcurrent: 1,                        // по одному запросу на client_id одновременно
  reservoir: PER_CLIENT_RPS,               // стартовое число токенов
  reservoirRefreshAmount: PER_CLIENT_RPS,  // каждые 1000 мс пополняем до PER_CLIENT_RPS
  reservoirRefreshInterval: 1000,
});

// ==== Ретраи ====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function isRateLimitError(err) {
  const http = err?.response?.status;
  const code = err?.response?.data?.code;
  const msg  = String(err?.response?.data?.message || err?.message || '').toLowerCase();
  return http === 429 || code === 8 || msg.includes('rate limit');
}

function isRetryableNetwork(err) {
  const http = err?.response?.status;
  const code = err?.code;
  return (http >= 500 && http < 600) || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN';
}

function nextDelayMs(err, attempt) {
  const hdr = err?.response?.headers?.['retry-after'];
  if (hdr) {
    const sec = Number(hdr);
    if (Number.isFinite(sec) && sec > 0) return sec * 1000;
  }
  const base = BACKOFF_BASE_MS * Math.pow(2, attempt); // 300, 600, 1200, 2400, 4800...
  const jitter = Math.floor(Math.random() * 200);
  return Math.min(BACKOFF_MAX_MS, base + jitter);
}

// ==== Публичная функция ====
async function ozonApiRequest({ client_id, api_key, endpoint, body }) {
  const url = `https://api-seller.ozon.ru${endpoint}`;
  const headers = {
    'Client-Id': client_id,
    'Api-Key': api_key,
    'Content-Type': 'application/json',
  };

  // лимитер на конкретный client_id
  const perClientLimiter = perClientGroup.key(String(client_id || 'NOCLIENT'));

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Каждый заход в цикл забирает НОВЫЙ токен per-client (≤2 rps) и проходит через глобальную concurrency
      const data = await globalLimiter.schedule(() =>
        perClientLimiter.schedule(() =>
          axios.post(url, body, { headers, timeout: REQUEST_TIMEOUT_MS, baseURL: 'https://api-seller.ozon.ru' })
        )
      );
      return data.data; // axios response.data
    } catch (err) {
      const retryable = isRateLimitError(err) || isRetryableNetwork(err);
      if (!retryable || attempt >= MAX_RETRIES) throw err;

      const ms = nextDelayMs(err, attempt);
      // console.warn(`[ozonApiRequest] retry in ${ms}ms (attempt ${attempt+1}/${MAX_RETRIES})`, err?.response?.data || err.message);
      await sleep(ms);
      // цикл продолжится и снова возьмёт токен из per-client лимитера (не превысим 2 rps)
    }
  }

  throw new Error('Ozon API retries exhausted');
}

module.exports = { ozonApiRequest };
