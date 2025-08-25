// utils/performanceApi.js
const axios = require('axios');

const TOKEN_URL = 'https://api-performance.ozon.ru/api/client/token';

/** "1 110,72" -> 1110.72 */
function parseMoney(str) {
  if (str == null) return 0;
  const clean = String(str).replace(/\s+/g, '').replace(',', '.');
  const n = parseFloat(clean);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Получить токен Performance API (OAuth2 Client Credentials).
 * Возвращает: { token, expiresIn, tokenType }
 */
async function getPerformanceToken({ client_id, client_secret }) {
  if (!client_id || !client_secret) {
    throw new Error('performance client_id/secret не заданы');
  }
  try {
    const body = new URLSearchParams();
    body.append('grant_type', 'client_credentials');
    body.append('client_id', client_id);
    body.append('client_secret', client_secret);

    const res = await axios.post(TOKEN_URL, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });

    const data = res?.data || {};
    const token     = data.access_token || data.accessToken;
    const expiresIn = Number(data.expires_in ?? data.expiresIn ?? 0);
    const tokenType = data.token_type || data.tokenType || 'Bearer';

    if (!token) throw new Error('В ответе нет access_token');
    return { token, expiresIn, tokenType };
  } catch (e) {
    const status = e?.response?.status;
    const body = e?.response?.data || e.message;
    console.error('[getPerformanceToken] error:', status, body);
    throw e;
  }
}

/**
 * Суммарная дневная статистика по всем кампаниям за дату.
 * Возвращает: { views:number, clicks:number, spent:number }
 */
async function getCampaignDailyStatsTotals({ client_id, client_secret, date }) {
  if (!date) throw new Error('date обязателен (YYYY-MM-DD)');

  const { token, tokenType } = await getPerformanceToken({ client_id, client_secret });

  // JSON-вариант согласно документации (+ явный порт 443 допустим, но не обязателен)
  const url = `https://api-performance.ozon.ru/api/client/statistics/daily/json?dateFrom=${date}&dateTo=${date}`;

  // Диагностический лог (без полного токена)
  console.log('[Performance] GET', url);
  console.log('[Performance] auth:', tokenType, (token || '').slice(0, 12) + '...');

  let res;
  try {
    res = await axios.get(url, {
      headers: {
        Authorization: `${tokenType} ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
      validateStatus: s => s >= 200 && s < 300, // пусть всё не-2xx пойдёт в catch
    });
  } catch (e) {
    console.error('[getCampaignDailyStatsTotals] HTTP error:', e?.response?.status, e?.response?.data || e.message);
    throw e;
  }

  const rows = Array.isArray(res?.data?.rows) ? res.data.rows : [];
  let views = 0, clicks = 0, spent = 0;

  for (const r of rows) {
    // в ответе часто строки — аккуратно приводим
    const v = Number(String(r?.views ?? '0').replace(/\s+/g, '')) || 0;
    const c = Number(String(r?.clicks ?? '0').replace(/\s+/g, '')) || 0;
    const m = parseMoney(r?.moneySpent);

    views  += v;
    clicks += c;
    spent  += m;
  }

  return { views, clicks, spent };
}

module.exports = {
  getPerformanceToken,
  getCampaignDailyStatsTotals,
};
