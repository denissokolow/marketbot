// utils/reportMtdSku.js
// Третье сообщение (MTD): с начала месяца до конца вчера.
// Источники:
//  • Заказано (шт., сумма) — /v1/analytics/data (dimension=sku)
//  • Выкуплено — считаем по /v3/finance/transaction/list:
//      - шт. = БРУТТО (только операции с accruals_for_sale > 0)
//      - сумма = Σ amount (net) по SKU (включая комиссии/логистику/сервисы)
//      - если сумма > 0, а шт. == 0 (бывают денежные корректировки) — показываем 1 шт. (fallback)
//  • Возвраты — шт. по операциям с accruals_for_sale < 0
//  • «В пути» — /v2/posting/fbo/list (status=delivering)
//  • Прибыль = Σ amount по SKU − (брутто-шт. × себестоимость)

const { ozonApiRequest } = require('../services/ozon/api');
const { getTodayISO, getYesterdayISO } = require('./utils');

const esc = (s = '') => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const firstWord = (s = '') => (String(s).trim().split(/\s+/)[0] || '');
const fmtMoney0 = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEBUG_MTD         = process.env.DEBUG_MTD === '1';
const DEBUG_MTD_DETAILS = process.env.DEBUG_MTD_DETAILS === '1';
const OZON_MAX_RETRIES     = Number(process.env.OZON_MAX_RETRIES || 5);
const OZON_BACKOFF_BASE_MS = Number(process.env.OZON_BACKOFF_BASE_MS || 300);

// базовый номер постинга для склейки весов
const basePosting = (p = '') => String(p || '').replace(/-\d+$/, '');

// --- период MTD ---
function getMtdRange() {
  const todayYmd = getTodayISO();         // YYYY-MM-DD
  const yesterdayYmd = getYesterdayISO(); // YYYY-MM-DD
  const [yy, mm] = todayYmd.split('-');
  const monthStartYmd = `${yy}-${mm}-01`;
  return {
    fromYmd: monthStartYmd,
    toYmd:   yesterdayYmd,
    fromISO: `${monthStartYmd}T00:00:00.000Z`,
    toISO:   `${yesterdayYmd}T23:59:59.999Z`,
    monthStartYmd,
    yesterdayYmd,
  };
}

// --- себестоимость по отслеживаемым SKU ---
async function getCostsMapForTracked(db, chatId, trackedSkus) {
  if (!db || !chatId) return new Map();
  const skus = (Array.isArray(trackedSkus) ? trackedSkus : [])
    .map(Number).filter(Number.isFinite);
  if (!skus.length) return new Map();

  const sql = `
    SELECT sp.sku::bigint AS sku, COALESCE(sp.net, 0)::numeric AS net
    FROM shop_products sp
    JOIN shops s ON s.id = sp.shop_id
    WHERE s.chat_id = $1
      AND sp.tracked = TRUE
      AND sp.sku = ANY($2::bigint[])
  `;
  const r = await db.query(sql, [chatId, skus]);
  const map = new Map();
  for (const row of r.rows || []) {
    const sku = Number(row.sku);
    if (Number.isFinite(sku)) map.set(sku, Number(row.net) || 0);
  }
  return map;
}

// --- analytics: «Заказано» ---
async function fetchAnalyticsSkuBulk({ client_id, api_key, date_from_ymd, date_to_ymd }) {
  const limit = 1000;
  let offset = 0;
  const rows = [];

  for (let attempt = 0; ; attempt++) {
    try {
      while (true) {
        const resp = await ozonApiRequest({
          client_id, api_key,
          endpoint: '/v1/analytics/data',
          body: {
            date_from: date_from_ymd,
            date_to:   date_to_ymd,
            metrics:   ['revenue', 'ordered_units'],
            dimension: ['sku'],
            filters:   [],
            sort:      [{ order: 'DESC' }],
            limit,
            offset,
          },
        });

        const data = Array.isArray(resp?.result?.data) ? resp.result.data
                   : Array.isArray(resp?.data)        ? resp.data
                   : [];

        if (DEBUG_MTD) console.log('[analytics:bulk] page', { offset, got: data.length });

        rows.push(...data);
        if (data.length < limit) break;
        offset += data.length;
      }
      break;
    } catch (e) {
      const code = e?.response?.data?.code ?? e?.code;
      if (code === 8 && attempt < OZON_MAX_RETRIES) {
        const pause = OZON_BACKOFF_BASE_MS * Math.pow(2, attempt);
        if (DEBUG_MTD) console.warn(`[analytics:bulk] rate-limit, retry ${attempt + 1}/${OZON_MAX_RETRIES} after ${pause}ms`);
        await sleep(pause);
        continue;
      }
      console.error('[analytics:bulk] ERROR', e?.response?.data || e.message);
      throw e;
    }
  }

  return rows;
}

// --- finance: все операции за период ---
async function fetchFinanceOpsAll({ client_id, api_key, fromISO, toISO }) {
  const page_size = 1000;
  let page = 1;
  const out = [];

  for (let attempt = 0; ; attempt++) {
    try {
      while (true) {
        const resp = await ozonApiRequest({
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
        if (DEBUG_MTD) console.log('[finance:list] page', { page, got: ops.length });

        out.push(...ops);
        if (ops.length < page_size) break;
        page += 1;
      }
      break;
    } catch (e) {
      const code = e?.response?.data?.code ?? e?.code;
      if (code === 8 && attempt < OZON_MAX_RETRIES) {
        const pause = OZON_BACKOFF_BASE_MS * Math.pow(2, attempt);
        if (DEBUG_MTD) console.warn(`[finance:list] rate-limit, retry ${attempt + 1}/${OZON_MAX_RETRIES} after ${pause}ms`);
        await sleep(pause);
        continue;
      }
      console.error('[finance:list] ERROR', e?.response?.data || e.message);
      throw e;
    }
  }

  return out;
}

// --- postings FBO: «В пути» (status=delivering) ---
async function fetchFboDeliveringCounts({ client_id, api_key, fromISO, toISO, trackedSet }) {
  const limit = 1000;
  let offset = 0;
  const counts = new Map(); // sku -> qty delivering

  for (let attempt = 0; ; attempt++) {
    try {
      while (true) {
        const resp = await ozonApiRequest({
          client_id, api_key,
          endpoint: '/v2/posting/fbo/list',
          body: {
            filter: { since: fromISO, to: toISO, status: '' },
            limit,
            offset,
            translit: true,
            with: { analytics_data: true, financial_data: true, legal_info: false },
          },
        });

        const postings = Array.isArray(resp?.result) ? resp.result
                        : Array.isArray(resp)        ? resp
                        : [];

        if (DEBUG_MTD) console.log('[fbo:list] page', { offset, got: postings.length });

        for (const p of postings) {
          const status = String(p?.status || '').toLowerCase();
          if (status !== 'delivering') continue;

          const products = Array.isArray(p?.products) ? p.products : [];
          for (const pr of products) {
            const sku = Number(pr?.sku || pr?.offer_id || 0);
            if (!Number.isFinite(sku)) continue;
            if (trackedSet && !trackedSet.has(sku)) continue;
            const qty = Number(pr?.quantity || pr?.qty || 0);
            counts.set(sku, (counts.get(sku) || 0) + (Number.isFinite(qty) ? qty : 0));
          }
        }

        if (postings.length < limit) break;
        offset += postings.length;
      }
      break;
    } catch (e) {
      const code = e?.response?.data?.code ?? e?.code;
      if (code === 8 && attempt < OZON_MAX_RETRIES) {
        const pause = OZON_BACKOFF_BASE_MS * Math.pow(2, attempt);
        if (DEBUG_MTD) console.warn(`[fbo:list] rate-limit, retry ${attempt + 1}/${OZON_MAX_RETRIES} after ${pause}ms`);
        await sleep(pause);
        continue;
      }
      console.error('[fbo:list] ERROR', e?.response?.data || e.message);
      throw e;
    }
  }

  return counts;
}

// --- группировка весов по постингам для операций без items ---
function buildGroupItems(ops) {
  const group = new Map(); // basePosting -> Map<sku, qty>
  for (const op of ops) {
    const base = basePosting(op?.posting_number || '');
    if (!base) continue;
    let m = group.get(base);
    if (!m) { m = new Map(); group.set(base, m); }
    const items = Array.isArray(op?.items) ? op.items : [];
    for (const it of items) {
      const sku = Number(it?.sku || 0);
      if (!Number.isFinite(sku)) continue;
      const q = Number(it?.quantity || 1);
      const w = Number.isFinite(q) ? q : 1;
      m.set(sku, (m.get(sku) || 0) + w);
    }
  }
  return group;
}

function splitByWeights(total, weightsMap) {
  let totalW = 0;
  weightsMap.forEach(w => totalW += w);
  if (totalW <= 0) return new Map();
  const res = new Map();
  weightsMap.forEach((w, sku) => {
    res.set(sku, (total * w) / totalW);
  });
  return res;
}

// ---------- основной рендер ----------
async function makeMtdPerSkuText(user, { trackedSkus = [], db = null, chatId = null } = {}) {
  const tracked = [...new Set((Array.isArray(trackedSkus) ? trackedSkus : []).map(Number).filter(Number.isFinite))];
  if (!tracked.length) return '<code>Нет отслеживаемых товаров для отчёта.</code>';
  const trackedSet = new Set(tracked);

  const { fromYmd, toYmd, fromISO, toISO, monthStartYmd, yesterdayYmd } = getMtdRange();
  if (DEBUG_MTD) console.log('[MTD] range', { fromYmd, toYmd, fromISO, toISO });

  // 1) Заказано (analytics)
  const analyticsRows = await fetchAnalyticsSkuBulk({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date_from_ymd: fromYmd,
    date_to_ymd:   toYmd,
  });
  const orderedMap = new Map(); // sku -> { ordered, revenue }
  const nameBySku  = new Map(); // sku -> title
  for (const row of analyticsRows) {
    const dim = row?.dimensions?.[0];
    const sku = Number(dim?.id);
    if (!Number.isFinite(sku) || !trackedSet.has(sku)) continue;
    const m = Array.isArray(row?.metrics) ? row.metrics : [0, 0];
    orderedMap.set(sku, { revenue: Number(m[0]||0), ordered: Number(m[1]||0) });
    const nm = String(dim?.name || '').trim();
    if (nm) nameBySku.set(sku, nm);
  }

  // 2) Себестоимость
  const costsMap = await getCostsMapForTracked(db, chatId, tracked);

  // 3) Финансовые операции — деньги и штуки
  const ops = await fetchFinanceOpsAll({
    client_id: user.client_id,
    api_key:   user.seller_api,
    fromISO,
    toISO,
  });

  const groupItems = buildGroupItems(ops);

  // агрегатор по SKU
  const agg = new Map(); // sku -> { posCnt, negCnt, amountSum }
  const ensure = (sku) => {
    let v = agg.get(sku);
    if (!v) { v = { posCnt:0, negCnt:0, amountSum:0 }; agg.set(sku, v); }
    return v;
  };

  for (const op of ops) {
    const amount = Number(op?.amount || 0);
    const accr   = Number(op?.accruals_for_sale ?? 0);

    // веса по items
    const weights = new Map();
    const items = Array.isArray(op?.items) ? op.items : [];
    if (items.length) {
      for (const it of items) {
        const sku = Number(it?.sku || 0);
        if (!Number.isFinite(sku)) continue;
        if (!trackedSet.has(sku)) continue;
        const q = Number(it?.quantity || 1);
        const w = Number.isFinite(q) ? q : 1;
        weights.set(sku, (weights.get(sku) || 0) + w);
        if (!nameBySku.has(sku) && it?.name) nameBySku.set(sku, String(it.name));
      }
    } else {
      const base = basePosting(op?.posting_number || '');
      const g = base ? groupItems.get(base) : null;
      if (g) {
        g.forEach((w, sku) => {
          if (!trackedSet.has(sku)) return;
          weights.set(sku, (weights.get(sku) || 0) + w);
        });
      }
    }
    if (weights.size === 0) continue;

    // распределяем деньги всегда
    const parts = splitByWeights(amount, weights);

    // считаем ШТУКИ ТОЛЬКО по accruals_for_sale:
    //  • >0  → брутто-выкуп (posCnt += qty)
    //  • <0  → возвраты (negCnt += qty)
    //  •  0  → сервисы/комиссии — количество НЕ трогаем
    const sign = Math.sign(accr);
    weights.forEach((w, sku) => {
      const slot = ensure(sku);
      if (sign > 0) slot.posCnt += w;
      else if (sign < 0) slot.negCnt += w;
    });

    parts.forEach((part, sku) => {
      const slot = ensure(sku);
      slot.amountSum += part; // net-деньги
    });
  }

  // 4) В пути
  const inTransitMap = await fetchFboDeliveringCounts({
    client_id: user.client_id,
    api_key:   user.seller_api,
    fromISO,
    toISO,
    trackedSet,
  });

  // ---------- рендер ----------
  const lines = [];
  lines.push(`<code>🏪 Магазин:  ${esc(user.shop_name || 'Неизвестно')}</code>`);
  lines.push('<code> - - - - </code>');
  lines.push(`<code>📆 Период:  ${esc(monthStartYmd)} → ${esc(yesterdayYmd)}</code>`);
  lines.push('<code> - - - - </code>');

  const fmtQty = (n) => (Number(n) ? `${Math.round(Number(n)).toLocaleString('ru-RU')} шт.` : 'нет');
  const fmtQtyMoney = (qty, sum) => {
    const q = Math.round(Number(qty) || 0);
    const s = Number(sum) || 0;
    if (q === 0 && s === 0) return 'нет';
    return `${q.toLocaleString('ru-RU')} шт. на ${fmtMoney0(s)}₽`;
  };
  const fmtMoneyOrNo = (n) => (Number(n) ? `${fmtMoney0(n)}₽` : 'нет');

  // сортировка по Σ amount (net) desc
  const orderSkus = [...tracked].sort((a, b) => {
    const ra = Number(agg.get(a)?.amountSum || 0);
    const rb = Number(agg.get(b)?.amountSum || 0);
    if (ra !== rb) return rb - ra;
    return a - b;
  });

  for (const sku of orderSkus) {
    const ord = orderedMap.get(sku) || { ordered: 0, revenue: 0 };
    const a   = agg.get(sku)       || { posCnt:0, negCnt:0, amountSum:0 };
    const net = Number(costsMap.get(sku) || 0);

    const grossCnt = a.posCnt;                  // брутто-шт. (только accr>0)
    const retCnt   = Math.max(0, a.negCnt);     // возвраты (шт.)
    const netAmt   = a.amountSum;               // деньги (net)

    // если есть деньги, но брутто-шт. == 0 → fallback 1 шт.
    const soldQtyForDisplay = (grossCnt > 0) ? grossCnt : (netAmt > 0 ? 1 : 0);

    const cogs   = grossCnt * net;              // себестоимость по брутто-шт.
    const profit = netAmt - cogs;

    const titleApi = nameBySku.get(sku) || '';
    const display  = firstWord(titleApi) || `SKU ${sku}`;

    const inTransitQty = Number(inTransitMap.get(sku) || 0);

    if (DEBUG_MTD_DETAILS) {
      console.log(`[MTD:SKU ${sku}] ${display}`);
      console.log(`  Заказано:        ${Math.round(ord.ordered)} шт. на ${fmtMoney0(ord.revenue)} ₽`);
      console.log(`  Amount (NET):    ${fmtMoney0(netAmt)} ₽`);
      console.log(`  Брутто шт.:      ${Math.round(grossCnt)}  | Возвраты шт.: ${Math.round(retCnt)}`);
      console.log(`  Себестоимость:   ${Math.round(grossCnt)} × ${fmtMoney0(net)} ₽ = ${fmtMoney0(cogs)} ₽`);
      console.log(`  В пути (шт):     ${Math.round(inTransitQty)}`);
      console.log(`  ⇒ Прибыль:       ${fmtMoney0(profit)} ₽\n`);
    }

    lines.push(`<code>🔹 ${esc(display)} (${sku})</code>`);
    lines.push(`<code>📦 Заказано: ${fmtQtyMoney(ord.ordered, ord.revenue)}</code>`);
    lines.push(`<code>✅ Выкуплено: ${fmtQtyMoney(soldQtyForDisplay, netAmt)}</code>`);
    lines.push(`<code>🚚 В пути: ${fmtQty(inTransitQty)}</code>`);
    lines.push(`<code>🔁 Возвраты: ${retCnt ? `${Math.round(retCnt).toLocaleString('ru-RU')} шт.` : 'нет'}</code>`);
    lines.push(`<code>💰 Прибыль: ${fmtMoneyOrNo(profit)}</code>`);
    lines.push('<code> - - - - </code>');
  }

  return lines.join('\n');
}

module.exports = { makeMtdPerSkuText };