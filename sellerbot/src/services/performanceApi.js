const axios = require('axios');

const BASE_URL  = 'https://api-performance.ozon.ru';
const TOKEN_URL = `${BASE_URL}/api/client/token`;

/** "1 110,72" -> 1110.72 */
function parseMoney(str) {
  if (str == null) return 0;
  if (typeof str === 'number') return str;
  const clean = String(str).replace(/\s+/g, '').replace(',', '.');
  const n = parseFloat(clean);
  return Number.isFinite(n) ? n : 0;
}
function parseIntSafe(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Math.trunc(v) || 0;
  const s = String(v).replace(/\s+/g, '');
  const n = parseInt(s, 10);
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

  const url = `${BASE_URL}/api/client/statistics/daily/json?dateFrom=${date}&dateTo=${date}`;

const DBG_PERF = process.env.DEBUG_PERF === '1';
if (DBG_PERF) {
  // показываем только хвост client_id и тип токена — сам токен не светим
  console.log('[Performance] GET', url);
  console.log('[Performance] auth:', tokenType, '(hidden)');
}

  let res;
  try {
    res = await axios.get(url, {
      headers: {
        Authorization: `${tokenType} ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
      validateStatus: s => s >= 200 && s < 300,
    });
  } catch (e) {
    console.error('[getCampaignDailyStatsTotals] HTTP error:', e?.response?.status, e?.response?.data || e.message);
    throw e;
  }

  const rows = Array.isArray(res?.data?.rows) ? res.data.rows : [];
  let views = 0, clicks = 0, spent = 0;

  for (const r of rows) {
    const v = parseIntSafe(r?.views);
    const c = parseIntSafe(r?.clicks);
    const m = parseMoney(r?.moneySpent);

    views  += v;
    clicks += c;
    spent  += m;
  }

  return { views, clicks, spent };
}

/**
 * Получить список продвигаемых объектов кампании.
 * Возвращает массив SKU (числа). Для баннерных кампаний может быть пусто.
 */
async function getCampaignObjects({ token, tokenType, campaignId }) {
  const url = `${BASE_URL}/api/client/campaign/${encodeURIComponent(campaignId)}/objects`;
  const res = await axios.get(url, {
    headers: { Authorization: `${tokenType} ${token}` },
    timeout: 20000,
    validateStatus: s => s >= 200 && s < 300,
  });
  const list = Array.isArray(res?.data?.list) ? res.data.list : [];
  const out = [];
  for (const it of list) {
    const skuNum = Number((it?.id ?? it?.sku ?? '').toString().replace(/\s+/g, ''));
    if (Number.isFinite(skuNum)) out.push(skuNum);
  }
  return out;
}

/**
 * Перекаст рекламных метрик (views, clicks, spent) к SKU за период
 * на основе сводки кампаний daily/json + /campaign/{id}/objects.
 *
 * Если у кампании есть явные объекты → делим метрики поровну между её SKU.
 * Если объектов нет и title включает «все товары» → делим между trackedSkus
 *   ПРОПОРЦИОНАЛЬНО allocationWeights[sku] (обычно — брутто-выручке SKU).
 * Если сумма весов <= 0 — делим поровну.
 *
 * Возвращает Map<sku, { views, clicks, spent }>
 */
async function getPerSkuStatsFromDaily({
  client_id,
  client_secret,
  date_from,
  date_to,
  trackedSkus = [],
  allocationWeights = null, // { [sku:number]: weight:number } — например, gross revenue
}) {
  if (!date_from || !date_to) throw new Error('date_from и date_to обязательны (YYYY-MM-DD)');
  const tracked = Array.from(new Set((trackedSkus || []).map(Number).filter(Number.isFinite)));

  const { token, tokenType } = await getPerformanceToken({ client_id, client_secret });

  // 1) Грузим сводку по кампаниям за период
  const url = `${BASE_URL}/api/client/statistics/daily/json?dateFrom=${date_from}&dateTo=${date_to}`;
const DBG_PERF = process.env.DEBUG_PERF === '1';
if (DBG_PERF) {
  // показываем только хвост client_id и тип токена — сам токен не светим
  console.log('[Performance] GET', url);
  console.log('[Performance] auth:', tokenType, '(hidden)');
}

  let res;
  try {
    res = await axios.get(url, {
      headers: { Authorization: `${tokenType} ${token}` },
      timeout: 30000,
      validateStatus: s => s >= 200 && s < 300,
    });
  } catch (e) {
    console.error('[getPerSkuStatsFromDaily] daily/json error:', e?.response?.status, e?.response?.data || e.message);
    throw e;
  }

  const rows = Array.isArray(res?.data?.rows) ? res.data.rows : [];

  // 2) Агрегируем метрики по campaignId
  const byCampaign = new Map(); // id -> { title, views, clicks, spent }
  for (const r of rows) {
    const id = String(r?.id || '').trim();
    if (!id) continue;
    const cur = byCampaign.get(id) || { title: r?.title || '', views: 0, clicks: 0, spent: 0 };
    cur.title   = cur.title || (r?.title || '');
    cur.views  += parseIntSafe(r?.views);
    cur.clicks += parseIntSafe(r?.clicks);
    cur.spent  += parseMoney(r?.moneySpent);
    byCampaign.set(id, cur);
  }

  // 3) Для каждой кампании узнаём SKU (кэшируем)
  const perSku = new Map(); // sku -> { views, clicks, spent }
  const objectsCache = new Map();

  const ensure = (sku) => {
    let v = perSku.get(sku);
    if (!v) { v = { views: 0, clicks: 0, spent: 0 }; perSku.set(sku, v); }
    return v;
  };

  const getWeight = (sku) => {
    if (!allocationWeights) return 1;
    const w = Number(allocationWeights[sku] || 0);
    return Number.isFinite(w) && w > 0 ? w : 0;
  };

  for (const [cid, agg] of byCampaign.entries()) {
    let skuList = objectsCache.get(cid);
    if (!skuList) {
      try {
        skuList = await getCampaignObjects({ token, tokenType, campaignId: cid });
      } catch (e) {
        console.warn('[getPerSkuStatsFromDaily] objects error for', cid, e?.response?.status, e?.message);
        skuList = [];
      }
      objectsCache.set(cid, skuList);
    }

    // оставляем только отслеживаемые SKU, если список задан
    let targets = skuList;
    if (tracked.length) targets = targets.filter(s => tracked.includes(s));

    // особый кейс «все товары»
    const isAllTitle = String(agg.title || '').toLowerCase().includes('все товары');
    if ((!targets || targets.length === 0) && isAllTitle && tracked.length) {
      targets = tracked.slice();
    }

    if (!targets || targets.length === 0) {
      // нет таргетов — пропускаем (баннер/кампания не по нашим SKU)
      continue;
    }

    // Распределяем: если это «все товары» и заданы веса — делим по весам, иначе поровну
    let totalWeight = 0;
    const weights = new Map();
    if (isAllTitle && allocationWeights) {
      for (const sku of targets) {
        const w = getWeight(sku);
        weights.set(sku, w);
        totalWeight += w;
      }
    }

    if (totalWeight > 0) {
      // по весам
      for (const sku of targets) {
        const w = weights.get(sku) || 0;
        if (w <= 0) continue;
        const k = w / totalWeight;
        const slot = ensure(Number(sku));
        slot.views  += agg.views  * k;
        slot.clicks += agg.clicks * k;
        slot.spent  += agg.spent  * k;
      }
    } else {
      // поровну
      const partViews  = agg.views  / targets.length;
      const partClicks = agg.clicks / targets.length;
      const partSpent  = agg.spent  / targets.length;
      for (const sku of targets) {
        const slot = ensure(Number(sku));
        slot.views  += partViews;
        slot.clicks += partClicks;
        slot.spent  += partSpent;
      }
    }
  }

  // округлим до целых для views/clicks
  perSku.forEach((v, sku) => {
    v.views  = Math.round(v.views);
    v.clicks = Math.round(v.clicks);
  });

  return perSku;
}

module.exports = {
  getPerformanceToken,
  getCampaignDailyStatsTotals,
  getPerSkuStatsFromDaily,
};
