// utils/reportMtdSku.js
// Третье сообщение (MTD): с начала месяца до конца вчера.
// Для каждого отслеживаемого SKU выводим:
//  - Заказано (шт. и сумма) из /v1/analytics/data (dimension=sku)
//  - Выкуплено: нетто-шт. (брутто-шт. − возвраты-шт.), сумма = Σ положительных accruals_for_sale (брутто-выручка)
//  - ⭕️ Расходы: Σ |sale_commission| + |processing_and_delivery| + |delivery_charge| + Σ |services[]| + |negative residual| (всё распределено по SKU)
//  - Доставляется: из /v2/posting/fbo/list (status = delivering)
//  - Возвраты (шт.): из /v1/returns/list по logistic_return_date (пагинация last_id)
//  - Прибыль = Выкуплено(брутто-выручка) − Расходы − Себестоимость(по брутто-шт.)

const { ozonApiRequest } = require('../services/ozon/api');
const { getTodayISO, getYesterdayISO } = require('./utils');

// ---------- helpers ----------
const esc = (s = '') => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const firstWord = (s = '') => (String(s).trim().split(/\s+/)[0] || '');
const fmtMoney0 = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEBUG_MTD         = process.env.DEBUG_MTD === '1';
const DEBUG_MTD_DETAILS = process.env.DEBUG_MTD_DETAILS === '1';

const OZON_MAX_RETRIES     = Number(process.env.OZON_MAX_RETRIES || 5);
const OZON_BACKOFF_BASE_MS = Number(process.env.OZON_BACKOFF_BASE_MS || 300);

// базовый номер постинга (обрезаем суффикс -N)
const basePosting = (p = '') => String(p || '').replace(/-\d+$/, '');

// ---------- период: MTD (с начала месяца по конец вчера) ----------
function getMtdRange() {
  const todayYmd = getTodayISO();         // YYYY-MM-DD
  const yesterdayYmd = getYesterdayISO(); // YYYY-MM-DD
  const [yy, mm] = todayYmd.split('-');
  const monthStartYmd = `${yy}-${mm}-01`;
  return {
    // analytics:
    fromYmd: monthStartYmd,
    toYmd:   yesterdayYmd,
    // finance / postings / returns:
    fromISO: `${monthStartYmd}T00:00:00.000Z`,
    toISO:   `${yesterdayYmd}T23:59:59.999Z`,
    // для шапки:
    monthStartYmd,
    yesterdayYmd,
  };
}

// ---------- себестоимость по отслеживаемым SKU ----------
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

// ---------- analytics: разрез по SKU (bulk) ----------
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

// ---------- finance: тянем все операции за период ----------
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

// ---------- postings FBO: считаем «Доставляется» (status = delivering) ----------
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
            filter: {
              since: fromISO,
              to: toISO,
              status: '',
            },
            limit,
            offset,
            translit: true,
            with: {
              analytics_data: true,
              financial_data: true,
              legal_info: false,
            },
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

// ---------- returns: корректный сбор возвратов по last_id и logistic_return_date ----------
async function fetchReturnsCounts({ client_id, api_key, fromISO, toISO, trackedSet }) {
  const limit = 500; // строго <= 500
  let last_id = 0;
  const counts = new Map(); // sku -> qty
  const seen = new Set();   // для дедупа по id/композиту

  for (let attempt = 0; ; attempt++) {
    try {
      while (true) {
        const resp = await ozonApiRequest({
          client_id, api_key,
          endpoint: '/v1/returns/list',
          body: {
            filter: {
              logistic_return_date: {
                time_from: fromISO,
                time_to:   toISO,
              },
            },
            limit,
            last_id,
          },
        });

        const result = resp?.result || resp || {};
        const items = Array.isArray(result?.returns) ? result.returns
                     : Array.isArray(result)         ? result
                     : [];

        if (DEBUG_MTD) {
          const dbgLast = (result?.last_id ?? last_id);
          console.log('[returns:list] page', { last_id, got: items.length, next: dbgLast });
        }

        if (!items.length) break;

        for (const rt of items) {
          const sku = Number(
            rt?.sku ??
            rt?.product?.sku ??
            rt?.product_id?.sku ??
            0
          );
          if (!Number.isFinite(sku)) continue;
          if (trackedSet && !trackedSet.has(sku)) continue;

          const id  = rt?.id ?? rt?.return_id ?? rt?.acceptance_id ?? null;
          const pn  = rt?.posting_number || rt?.posting?.posting_number || '';
          const idx = rt?.item_index ?? rt?.item_id ?? rt?.index ?? 0;
          const key = id != null ? `id:${id}` : `pn:${pn}|sku:${sku}|idx:${idx}`;
          if (seen.has(key)) continue;
          seen.add(key);

          counts.set(sku, (counts.get(sku) || 0) + 1);
        }

        const next = Number(result?.last_id ?? 0);
        if (!next || next === last_id) break;
        last_id = next;
      }
      break;
    } catch (e) {
      const code = e?.response?.data?.code ?? e?.code;
      if (code === 8 && attempt < OZON_MAX_RETRIES) {
        const pause = OZON_BACKOFF_BASE_MS * Math.pow(2, attempt);
        if (DEBUG_MTD) console.warn(`[returns:list] rate-limit, retry ${attempt + 1}/${OZON_MAX_RETRIES} after ${pause}ms`);
        await sleep(pause);
        continue;
      }
      console.error('[returns:list] ERROR', e?.response?.data || e.message);
      throw e;
    }
  }

  return counts;
}

// построим «веса» по товарам в рамках одного posting_number
function buildGroupItems(ops) {
  const group = new Map(); // basePosting -> Map<sku, occurrences>
  for (const op of ops) {
    const base = basePosting(op?.posting_number || '');
    if (!base) continue;
    let m = group.get(base);
    if (!m) { m = new Map(); group.set(base, m); }
    const items = Array.isArray(op?.items) ? op.items : [];
    for (const it of items) {
      const sku = Number(it?.sku || 0);
      if (!Number.isFinite(sku)) continue;
      const w = Number(it?.quantity || 1);
      m.set(sku, (m.get(sku) || 0) + (Number.isFinite(w) ? w : 1));
    }
  }
  return group;
}

// распределение value по SKU на основе весов
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
  // нормализуем tracked
  const tracked = [...new Set(
    (Array.isArray(trackedSkus) ? trackedSkus : [])
      .map(Number).filter(Number.isFinite)
  )];
  if (!tracked.length) return '<code>Нет отслеживаемых товаров для отчёта.</code>';
  const trackedSet = new Set(tracked);

  const { fromYmd, toYmd, fromISO, toISO, monthStartYmd, yesterdayYmd } = getMtdRange();
  if (DEBUG_MTD) console.log('[MTD] range', { fromYmd, toYmd, fromISO, toISO });

  // 1) Заказано за MTD (analytics -> только tracked)
  const analyticsRows = await fetchAnalyticsSkuBulk({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date_from_ymd: fromYmd,
    date_to_ymd:   toYmd,
  });

  const orderedMap = new Map();         // sku -> { ordered, revenue }
  const nameBySku  = new Map();         // sku -> title (из analytics приоритетно)
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

  // 3) Финансовые операции: агрегируем по SKU
  const ops = await fetchFinanceOpsAll({
    client_id: user.client_id,
    api_key:   user.seller_api,
    fromISO,
    toISO,
  });

  const groupItems = buildGroupItems(ops);

  const agg = new Map(); // sku -> { grossAccrPos, posCnt, negCnt, expenses }
  const ensure = (sku) => {
    let v = agg.get(sku);
    if (!v) { v = { grossAccrPos:0, posCnt:0, negCnt:0, expenses:0 }; agg.set(sku, v); }
    return v;
  };

  for (const op of ops) {
    // собираем веса
    const weights = new Map();
    const items = Array.isArray(op?.items) ? op.items : [];
    if (items.length) {
      for (const it of items) {
        const sku = Number(it?.sku || 0);
        if (!Number.isFinite(sku)) continue;
        if (!trackedSet.has(sku)) continue;
        const w = Number(it?.quantity || 1);
        weights.set(sku, (weights.get(sku) || 0) + (Number.isFinite(w) ? w : 1));

        if (!nameBySku.has(sku) && it?.name) nameBySku.set(sku, String(it.name));
      }
    } else {
      const base = basePosting(op?.posting_number || '');
      const g = base ? groupItems.get(base) : null;
      if (g) g.forEach((w, sku) => { if (trackedSet.has(sku)) weights.set(sku, (weights.get(sku)||0)+w); });
    }
    if (weights.size === 0) continue;

    // поля операции
    const accr  = Number(op?.accruals_for_sale || 0);
    const comm  = Number(op?.sale_commission || 0);
    const proc  = Number(op?.processing_and_delivery || 0);
    const deliv = Number(op?.delivery_charge || 0);
    let services = 0;
    const srv = Array.isArray(op?.services) ? op.services : [];
    for (const s of srv) services += Number(s?.price || 0);

    // остаток (residual), если сумма полей не равна amount
    const amount = Number(op?.amount || 0);
    const residual = amount - (accr + comm + proc + deliv + services);
    const residualNeg = residual < 0 ? residual : 0; // только отрицательный остаток трактуем как расход

    // распределение по SKU
    const accrPos = accr > 0 ? accr : 0;
    const accrPosParts = splitByWeights(accrPos, weights);

    const commParts  = splitByWeights(comm,  weights);
    const procParts  = splitByWeights(proc,  weights);
    const delivParts = splitByWeights(deliv, weights);
    const servParts  = splitByWeights(services, weights);
    const residParts = splitByWeights(residualNeg, weights);

    // запись в агрегат
    weights.forEach((w, sku) => {
      const slot = ensure(sku);

      // брутто выручка (только положительные начисления)
      slot.grossAccrPos += (accrPosParts.get(sku) || 0);

      // штучные счётчики
      if (accr > 0) slot.posCnt += w;
      else if (accr < 0) slot.negCnt += w;

      // расходы — сумма модулей всех минусовых компонентов
      const e =
        Math.abs(commParts.get(sku)  || 0) +
        Math.abs(procParts.get(sku)  || 0) +
        Math.abs(delivParts.get(sku) || 0) +
        Math.abs(servParts.get(sku)  || 0) +
        Math.abs(residParts.get(sku) || 0);

      slot.expenses += e;
    });

    if (DEBUG_MTD_DETAILS) {
      const pn = op?.posting_number || '-';
      console.log(`[MTD:OP ${pn}] accr=${accr} comm=${comm} proc=${proc} deliv=${deliv} services=${services} amount=${amount} residual=${residual}`);
    }
  }

  // 4) «Доставляется» и «Возвраты»
  const inTransitMap = await fetchFboDeliveringCounts({
    client_id: user.client_id,
    api_key:   user.seller_api,
    fromISO,
    toISO,
    trackedSet,
  });

  const returnsMap = await fetchReturnsCounts({
    client_id: user.client_id,
    api_key:   user.seller_api,
    fromISO,
    toISO,
    trackedSet,
  });

  // ---------- шапка ----------
  const lines = [];
  lines.push(`<code>🏪 Магазин:  ${esc(user.shop_name || 'Неизвестно')}</code>`);
  lines.push('<code> - - - - </code>');
  lines.push(`<code>📆 Период:  ${esc(monthStartYmd)} → ${esc(yesterdayYmd)}</code>`);
  lines.push('<code> - - - - </code>');

  // сортировка: по брутто-выручке desc, затем по SKU
  const orderSkus = [...tracked].sort((a, b) => {
    const ra = Number(agg.get(a)?.grossAccrPos || 0);
    const rb = Number(agg.get(b)?.grossAccrPos || 0);
    if (ra !== rb) return rb - ra;
    return a - b;
  });

  // ---------- блоки по SKU ----------
  let totalProfit = 0;

  for (const sku of orderSkus) {
    const ord = orderedMap.get(sku) || { ordered: 0, revenue: 0 };
    const a   = agg.get(sku)       || { grossAccrPos:0, posCnt:0, negCnt:0, expenses:0 };
    const net = Number(costsMap.get(sku) || 0);

    const netCnt     = Math.max(0, a.posCnt - a.negCnt); // нетто-шт.
    const grossRev   = a.grossAccrPos;                   // брутто выручка (Σ accruals_for_sale>0)
    const expenses   = a.expenses;                       // распределённые расходы
    const grossUnits = Math.max(0, a.posCnt);            // брутто-шт. (для себестоимости)
    const costTotal  = grossUnits * net;                 // себестоимость
    const profit     = grossRev - expenses - costTotal;  // прибыль

    totalProfit += profit;

    const titleApi = nameBySku.get(sku) || '';
    const display  = firstWord(titleApi) || `SKU ${sku}`;
    const inTransitQty = Number(inTransitMap.get(sku) || 0);
    const returnsQty   = Number(returnsMap.get(sku) || 0);

    // формат "нет" при нуле
    const qtyLine = (n) => Number(n) ? `${Math.round(Number(n)).toLocaleString('ru-RU')} шт.` : 'нет';
    const qtyMoneyLine = (qty, sum) =>
      Number(qty) ? `${Math.round(Number(qty)).toLocaleString('ru-RU')} шт. на ${fmtMoney0(sum)}₽` : 'нет';

    lines.push(`<code>🔹 ${esc(display)} (${sku})</code>`);
    lines.push(`<code>📦 Заказано: ${qtyMoneyLine(ord.ordered, ord.revenue)}</code>`);
    lines.push(`<code>✅ Выкуплено: ${qtyMoneyLine(netCnt, grossRev)}</code>`);
    lines.push(`<code>⭕️ Расходы: ${Number(expenses) ? `${fmtMoney0(expenses)}₽` : 'нет'}</code>`);
    lines.push(`<code>🚚 Доставляется: ${qtyLine(inTransitQty)}</code>`);
    lines.push(`<code>🔁 Возвраты: ${returnsQty ? `${returnsQty.toLocaleString('ru-RU')} шт.` : 'нет'}</code>`);
    lines.push(`<code>💰 Прибыль: ${Number(profit) ? `${fmtMoney0(profit)}₽` : 'нет'}</code>`);
    lines.push('<code> - - - - </code>');

    if (DEBUG_MTD_DETAILS) {
      console.log(`[MTD:SKU ${sku}] ${display}
  Заказано:        ${ord.ordered} шт. на ${fmtMoney0(ord.revenue)} ₽
  Брутто выручка:  ${fmtMoney0(grossRev)} ₽
  Брутто шт.:      ${Math.round(a.posCnt)}  | Возвраты шт.: ${Math.round(a.negCnt)} | Нетто шт.: ${Math.round(netCnt)}
  Расходы:         ${fmtMoney0(expenses)} ₽
  Себестоимость:   ${Math.round(grossUnits)} × ${fmtMoney0(net)} ₽ = ${fmtMoney0(costTotal)} ₽
  Доставляется:    ${inTransitQty}
  Возвраты (v1):   ${returnsQty}
  ⇒ Прибыль:       ${fmtMoney0(profit)} ₽`);
    }
  }

  // итог по прибыли
  lines.push(`<code>💰 Общая прибыль: ${fmtMoney0(totalProfit)}₽</code>`);

  return lines.join('\n');
}

module.exports = {
  makeMtdPerSkuText,
};
