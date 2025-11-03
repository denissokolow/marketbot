// sellerbot/src/utils/reportYestSku.js
// Перечень по SKU за ВЧЕРА (одним сообщением, строго как в примере).
// Формат на каждый SKU:
//   📦 Название (SKU)
//   ▫️ Заказано: X шт. на Y₽ | нет
//   ▫️ Выкуплено: X шт. на Y₽ | нет   ← ₽ теперь из amount>0 (нетто), распределённого по SKU
//   ▫️ Возвраты: X шт. | нет
//   ▫️ Отмены: X шт. | нет
//   ▫️ Брак (в возвратах): X шт. | нет
//   (❗|▫️) Остаток на складе: Z шт.
//   (❗️|▫️) Д.Р.Р.: xx,xx% | —
//   - - - - 

const { getYesterdayISO } = require('../utils/dates');
const { getPerSkuSpendByDay } = require('../services/perfSkuSpend');

// ---- утилиты ----
const esc = (s='') => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmtMoney = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU');
const fmtInt   = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU');
const fmtPct2  = (x) => (x == null || !Number.isFinite(x))
  ? '—'
  : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x) + '%';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const includesBrak = (s) => typeof s === 'string' && s.toLowerCase().includes('брак');
const firstWord = (s='') => (String(s).trim().split(/\s+/)[0] || '');

// Пороги из ENV (с дефолтами)
const YEST_DRR_WARN_GT   = Number(process.env.YEST_DRR_WARN_GT   ?? 10); // %
const YEST_STOCK_LOW_LE  = Number(process.env.YEST_STOCK_LOW_LE  ?? 5);  // шт.

// ---- безопасные вызовы ----
async function safeCall(fn, fallback, args) {
  if (typeof fn !== 'function') return fallback;
  try { return await fn(args); } catch { return fallback; }
}

// ---- Ozon низкоуровневый запрос (ищем доступную функцию клиента) ----
async function ozRequest({ client_id, api_key, endpoint, body }) {
  try {
    const oz = require('../services/ozon');
    if (typeof oz.ozonApiRequest === 'function') {
      return await oz.ozonApiRequest({ client_id, api_key, endpoint, body });
    }
    if (oz.api && typeof oz.api.request === 'function') {
      return await oz.api.request({ client_id, api_key, endpoint, body });
    }
    if (typeof oz.request === 'function') {
      return await oz.request({ client_id, api_key, endpoint, body });
    }
    throw new Error('Ozon API request function not found');
  } catch (e) {
    return null;
  }
}

// ---- tracked SKUs (если есть колонка tracked — фильтруем по ней) ----
async function hasColumn(db, table, column) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2 LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}
async function getTrackedSkus(db, chatId) {
  const trackedExists = await hasColumn(db, 'shop_products', 'tracked');
  const sqlBase = `
    SELECT sp.sku::bigint AS sku
      FROM shop_products sp
      JOIN shops s ON s.id = sp.shop_id
      JOIN users u ON u.id = s.user_id
     WHERE u.chat_id = $1
  `;
  const sql = trackedExists ? `${sqlBase} AND sp.tracked = TRUE` : sqlBase;
  const r = await db.query(sql, [chatId]);
  return (r.rows || []).map(x => Number(x.sku)).filter(Number.isFinite);
}

// ---- analytics per SKU (вчера) ----
async function fetchAnalyticsSkuYesterday({ client_id, api_key, ymd }) {
  const rows = [];
  const limit = 1000;
  let offset = 0;
  while (true) {
    const resp = await ozRequest({
      client_id, api_key,
      endpoint: '/v1/analytics/data',
      body: {
        date_from: ymd,
        date_to:   ymd,
        metrics:   ['revenue', 'ordered_units'],
        dimension: ['sku'],
        sort: [{ key: 'revenue', order: 'DESC' }],
        limit,
        offset,
      },
    });
    const data = Array.isArray(resp?.result?.data) ? resp.result.data
               : Array.isArray(resp?.data)        ? resp.data
               : [];
    rows.push(...data);
    if (data.length < limit) break;
    offset += data.length;
    await sleep(50);
  }
  return rows;
}

// ---- finance: операции с items за вчера (используем только с items) ----
async function fetchFinanceOpsYesterday({ client_id, api_key, fromISO, toISO }) {
  const out = [];
  const page_size = 1000;
  let page = 1;
  while (true) {
    const resp = await ozRequest({
      client_id, api_key,
      endpoint: '/v3/finance/transaction/list',
      body: {
        filter: {
          date: { from: fromISO, to: toISO },
          operation_type: [],
          posting_number: '',
          transaction_type: 'all',
        },
        page,
        page_size,
      },
    });
    const ops = Array.isArray(resp?.result?.operations) ? resp.result.operations : [];
    out.push(...ops);
    if (resp?.result?.has_next === true) { page += 1; await sleep(50); } else break;
  }
  // оставляем только операции с items
  return out.filter(op => Array.isArray(op?.items) && op.items.length);
}

// ---- returns + cancellations + брак (вчера) ----
async function fetchReturnsAndCancelsYesterday({ client_id, api_key, fromISO, toISO }) {
  const returnCounts = new Map(); // sku -> qty (ClientReturn)
  const cancelCounts = new Map(); // sku -> qty (Cancellation)
  const brakCounts   = new Map(); // sku -> qty (по тексту причины)
  const seen = new Set();

  const limit = 500;
  let last_id = 0;

  while (true) {
    const resp = await ozRequest({
      client_id, api_key,
      endpoint: '/v1/returns/list',
      body: {
        filter: { logistic_return_date: { time_from: fromISO, time_to: toISO } },
        limit, last_id,
      },
    });
    const result = resp?.result || resp || {};
    const items = Array.isArray(result?.returns) ? result.returns : [];
    if (!items.length) break;

    for (const rt of items) {
      const product = rt?.product || {};
      const sku = Number(product?.sku ?? 0);
      if (!Number.isFinite(sku)) continue;

      const id  = rt?.id ?? rt?.return_id ?? rt?.acceptance_id ?? null;
      const pn  = rt?.posting_number || '';
      const idx = rt?.item_index ?? 0;
      const key = id != null ? `id:${id}` : `pn:${pn}|sku:${sku}|idx:${idx}`;
      if (seen.has(key)) continue; seen.add(key);

      const q = Number.isFinite(Number(product?.quantity))
        ? Number(product?.quantity)
        : 1;

      const type = String(rt?.type || '').trim();
      if (type === 'ClientReturn') {
        returnCounts.set(sku, (returnCounts.get(sku) || 0) + q);
      } else if (type === 'Cancellation') {
        cancelCounts.set(sku, (cancelCounts.get(sku) || 0) + q);
      }
      const reason = rt?.return_reason_name || '';
      if (includesBrak(reason)) brakCounts.set(sku, (brakCounts.get(sku) || 0) + q);
    }

    const next = Number(result?.last_id ?? 0);
    if (!next || next === last_id) break;
    last_id = next;
    await sleep(30);
  }

  return { returnCounts, cancelCounts, brakCounts };
}

// ---- остатки по SKU (текущее состояние складов) ----
async function fetchStocksMap({ client_id, api_key, skus }) {
  const set = new Set((skus || []).map(Number).filter(Number.isFinite));
  const map = new Map(); // sku -> qty суммарно
  let cursor = '';
  for (let i = 0; i < 50; i++) {
    const resp = await ozRequest({
      client_id, api_key,
      endpoint: '/v4/product/info/stocks',
      body: { cursor, filter: { visibility: 'ALL' }, limit: 100 },
    });
    const items = resp?.result?.items || resp?.items || [];
    for (const it of items) {
      const stocks = Array.isArray(it?.stocks) ? it.stocks : [];
      for (const st of stocks) {
        const sku = Number(st?.sku || 0);
        if (!Number.isFinite(sku) || (set.size && !set.has(sku))) continue;
        const qty = Number(
          st?.present ?? st?.free_to_sell ?? st?.sellable ?? st?.stock ?? st?.balance ?? 0
        );
        map.set(sku, (map.get(sku) || 0) + (Number.isFinite(qty) ? qty : 0));
      }
    }
    const next = resp?.result?.cursor ?? resp?.cursor ?? '';
    cursor = typeof next === 'string' ? next : '';
    if (!cursor) break;
    await sleep(50);
  }
  return map;
}

// Перфоманс-креды магазина (универсально под обе схемы колонок)
async function getPerformanceCreds(db, chatId) {
  const hasPerfId      = await hasColumn(db, 'shops', 'perf_client_id');
  const hasPerfSecret  = await hasColumn(db, 'shops', 'perf_client_secret');
  const hasOldId       = await hasColumn(db, 'shops', 'performance_client_id');
  const hasOldSecret   = await hasColumn(db, 'shops', 'performance_secret');

  const colId     = hasPerfId ? 'perf_client_id' : (hasOldId ? 'performance_client_id' : null);
  const colSecret = hasPerfSecret ? 'perf_client_secret' : (hasOldSecret ? 'performance_secret' : null);

  if (!colId || !colSecret) return null;

  const q = await db.query(
    `
    SELECT s.${colId}     AS client_id,
           s.${colSecret} AS client_secret
      FROM shops s
      JOIN users u ON u.id = s.user_id
     WHERE u.chat_id = $1
     ORDER BY s.created_at DESC NULLS LAST, s.id DESC
     LIMIT 1
    `,
    [chatId]
  );
  if (!q.rowCount) return null;

  const row = q.rows[0];
  if (!row.client_id || !row.client_secret) return null;
  return { client_id: row.client_id, client_secret: row.client_secret };
}

async function getAdSpendPerSkuYesterday({ db, chatId, trackedSkus, fromYmd, toYmd }) {
  try {
    const perf = require('../services/performanceApi');
    if (typeof perf?.getPerSkuStatsFromDaily !== 'function') return new Map();
    const creds = await getPerformanceCreds(db, chatId);
    if (!creds) return new Map();
    return await perf.getPerSkuStatsFromDaily({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      date_from: fromYmd,
      date_to:   toYmd,
      trackedSkus,
      allocationWeights: Object.fromEntries(trackedSkus.map(sku => [sku, 1])),
    });
  } catch {
    return new Map();
  }
}

// ---- главный рендер ----
async function makeYesterdayPerSkuText(user, { db = null, chatId = null } = {}) {
  const ymd = getYesterdayISO();
  const fromISO = `${ymd}T00:00:00.000Z`;
  const toISO   = `${ymd}T23:59:59.999Z`;

  // 1) tracked
  const tracked = (db && chatId) ? await getTrackedSkus(db, chatId) : [];
  if (!tracked.length) {
    return `<code>📆 Отчёт по товарам за: ${ymd}</code>\n<code> - - - - </code>\n<code>Нет отслеживаемых товаров.</code>`;
  }
  const trackedSet = new Set(tracked);

  // 2) analytics по SKU за вчера
  const analyticsRows = await fetchAnalyticsSkuYesterday({
    client_id: user.client_id,
    api_key:   user.seller_api,
    ymd,
  });
  const orderedMap = new Map(); // sku -> { ordered, revenue }
  const nameBySku  = new Map();
  for (const row of analyticsRows) {
    const dim = row?.dimensions?.[0];
    const sku = Number(dim?.id);
    if (!Number.isFinite(sku) || !trackedSet.has(sku)) continue;
    const m = Array.isArray(row?.metrics) ? row.metrics : [0, 0];
    orderedMap.set(sku, { revenue: Number(m[0]||0), ordered: Number(m[1]||0) });
    const nm = String(dim?.name || '').trim();
    if (nm) nameBySku.set(sku, nm);
  }

  // 3) финоперации с items за вчера → выкуплено шт./₽ (₽ — теперь из amount>0)
  const ops = await fetchFinanceOpsYesterday({
    client_id: user.client_id,
    api_key:   user.seller_api,
    fromISO, toISO,
  });

  // sku -> агрегаты
  const agg = new Map(); // { buyoutRub, posCnt, negCnt }
  const ensure = (sku) => {
    let v = agg.get(sku);
    if (!v) { v = { buyoutRub:0, posCnt:0, negCnt:0 }; agg.set(sku, v); }
    return v;
  };

  // распределение по весам (quantity в пределах одной операции)
  function splitByWeights(total, weightsMap) {
    let totalW = 0; weightsMap.forEach(w => totalW += w);
    if (totalW <= 0) return new Map();
    const res = new Map();
    weightsMap.forEach((w, sku) => { res.set(sku, (total * w) / totalW); });
    return res;
  }

  for (const op of ops) {
    const items = Array.isArray(op?.items) ? op.items : [];
    const weights = new Map();
    for (const it of items) {
      const sku = Number(it?.sku || 0);
      if (!Number.isFinite(sku) || !trackedSet.has(sku)) continue;
      const q = Number(it?.quantity || 1);
      weights.set(sku, (weights.get(sku) || 0) + (Number.isFinite(q) ? q : 1));
      if (!nameBySku.has(sku) && it?.name) nameBySku.set(sku, String(it.name));
    }
    if (weights.size === 0) continue;

    const amt = Number(op?.amount || 0);
    const amtPos = amt > 0 ? amt : 0;

    // ₽ по SKU — делим положительный amount пропорционально количеству
    const amtPosParts = splitByWeights(amtPos, weights);
    weights.forEach((w, sku) => {
      const slot = ensure(sku);
      slot.buyoutRub += (amtPosParts.get(sku) || 0);
    });

    // счётчики «шт.»: + для deliveries, − для возвратных операций
    const opTypeName = String(op?.operation_type_name || '');
    const isDelivery = op?.type === 'orders' && opTypeName === 'Доставка покупателю';
    const isReturnOp = op?.type === 'returns' || /возврат/i.test(opTypeName);

    if (amt > 0 && isDelivery) {
      weights.forEach((w, sku) => { ensure(sku).posCnt += w; });
    } else if (amt < 0 && isReturnOp) {
      weights.forEach((w, sku) => { ensure(sku).negCnt += w; });
    }
  }

  // 4) возвраты/отмены/брак (по returns/list за вчера)
  const { returnCounts, cancelCounts, brakCounts } = await fetchReturnsAndCancelsYesterday({
    client_id: user.client_id,
    api_key:   user.seller_api,
    fromISO, toISO,
  });

  // 5) остатки (текущие)
  const stocksMap = await fetchStocksMap({
    client_id: user.client_id,
    api_key:   user.seller_api,
    skus: tracked,
  });

  // 6) реклама per SKU за вчера
  let ppcBySku = new Map();
  let totalPpcSpend = 0;
  try {
    const creds = await getPerformanceCreds(db, chatId);
    if (creds) {
      const trackedList = Array.from(trackedSet);
      let allocationWeights = null;
      if (process.env.YEST_DRR_ALLOC_WEIGHTS === 'orders') {
        allocationWeights = {};
        for (const [sku, ord] of orderedMap) {
          allocationWeights[Number(sku)] = Number(ord?.revenue || 0);
        }
      }
      const { map, meta } = await getPerSkuSpendByDay({
        date: ymd,
        perfCreds: { client_id: creds.client_id, client_secret: creds.client_secret },
        trackedSkus: trackedList,
        allocationWeights,
      });
      ppcBySku = map;
      totalPpcSpend = Number(meta?.total_spend || 0);
      if (process.env.DEBUG_YEST_PER_SKU === '1') console.log('[perf-per-sku:daily]', meta);
    } else if (process.env.DEBUG_YEST_PER_SKU === '1') {
      console.log('[perf-per-sku] no performance creds for chat', chatId);
    }
  } catch (e) {
    console.warn('[yesterday per-sku] perf spend error:', e?.response?.data || e.message);
  }

  // 7) вывод
  const lines = [];
  lines.push(`<code>📆 Отчёт по товарам за: ${ymd}</code>`);
  lines.push('<code> - - - - </code>');

  // сортировка: по выкупной сумме (amount>0) desc, затем по SKU
  const orderSkus = [...tracked].sort((a, b) => {
    const ra = Number(agg.get(a)?.buyoutRub || 0);
    const rb = Number(agg.get(b)?.buyoutRub || 0);
    if (rb !== ra) return rb - ra;
    return a - b;
  });

  const qtyLine = (n) => Number(n) ? `${fmtInt(n)} шт.` : 'нет';
  const qtyMoneyLine = (qty, sum) =>
    Number(qty) ? `${fmtInt(qty)} шт. на ${fmtMoney(sum)}₽` : 'нет';

  for (const sku of orderSkus) {
    const ord = orderedMap.get(sku) || { ordered:0, revenue:0 };
    const a   = agg.get(sku)       || { buyoutRub:0, posCnt:0, negCnt:0 };
    const netCnt   = Math.max(0, Number(a.posCnt || 0) - Number(a.negCnt || 0));
    const buyoutRp = Number(a.buyoutRub || 0); // ₽ — из amount>0

    const returnsQty = Number(returnCounts.get(sku) || 0);
    const cancelsQty = Number(cancelCounts.get(sku) || 0);
    const brakQty    = Number(brakCounts.get(sku)   || 0);
    const stockQty   = Number(stocksMap.get(sku)    || 0);

    // ===== ДРР по SKU =====
    let drrStr  = '—';
    let drrIcon = '▫️';
    const adSpend = Number(ppcBySku.get(sku) ?? 0);
    const denom   = Number(ord?.revenue ?? 0); // "Заказано на сумму" по SKU
    if (adSpend > 0 && denom > 0) {
      const drrVal = (adSpend / denom) * 100;
      drrStr = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                  .format(drrVal) + '%';
      const warnGt = Number(process.env.YEST_DRR_WARN_GT || process.env.DRR_HIGH || 10);
      drrIcon = (drrVal > warnGt) ? '🔺' : '▫️';
    } else if (adSpend > 0 && denom <= 0) {
      const sharePct = totalPpcSpend > 0 ? (adSpend / totalPpcSpend) * 100 : null;
      const pctStr = (sharePct != null)
        ? new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(sharePct) + '%'
        : '—';
      drrStr  = `${pctStr} (${fmtMoney(adSpend)}₽), заказов нет`;
      drrIcon = '❗';
      if (process.env.DEBUG_YEST_PER_SKU === '1') {
        console.log('[yest-sku-DRR:no-orders]', { sku, adSpend, totalPpcSpend, sharePct });
      }
    } else {
      if (process.env.DEBUG_YEST_PER_SKU === '1') {
        console.log('[yest-sku-DRR:skip]', { sku, adSpend, revenue: denom });
      }
    }

    const stockIcon = (stockQty <= YEST_STOCK_LOW_LE) ? '❗️' : '▫️';
    const titleApi  = nameBySku.get(sku) || '';
    const display   = firstWord(titleApi) || `SKU ${sku}`;

    lines.push(`<code>📦 ${esc(display)} (${sku})</code>`);
    lines.push(`<code>▫️ Заказано: ${qtyMoneyLine(ord.ordered, ord.revenue)}</code>`);
    lines.push(`<code>▫️ Выкуплено: ${qtyMoneyLine(netCnt, buyoutRp)}</code>`);
    lines.push(`<code>▫️ Возвраты: ${qtyLine(returnsQty)}</code>`);
    lines.push(`<code>▫️ Отмены: ${qtyLine(cancelsQty)}</code>`);
    lines.push(`<code>▫️ Брак (в возвратах): ${qtyLine(brakQty)}</code>`);
    lines.push(`<code>${stockIcon} Остаток на складе: ${fmtInt(stockQty)} шт.</code>`);
    lines.push(`<code>${drrIcon} Д.Р.Р.: ${drrStr}</code>`);
    lines.push('<code> - - - - </code>');
  }

  return lines.join('\n');
}

module.exports = { makeYesterdayPerSkuText };
