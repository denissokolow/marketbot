// src/utils/reportText.js
const oz = require('../services/ozon');

// ===================== утилиты форматирования =====================
function esc(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function formatMoney(n) {
  const v = Number(n) || 0;
  return Math.round(v).toLocaleString('ru-RU');
}
function formatInt(n) {
  return Math.round(Number(n) || 0).toLocaleString('ru-RU');
}

// YYYY-MM-DD по Europe/Moscow
function getTodayISO() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}

// Универсальный вызов к Ozon Seller API
async function ozRequest({ client_id, api_key, endpoint, body }) {
  try {
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
    if (process.env.DEBUG_TODAY === '1') {
      console.error('[reportText] ozRequest error:', e?.response?.data || e);
    }
    return null;
  }
}

// ===================== totals и расходы =====================
// /v3/finance/transaction/totals → агрегаты за день
async function getFinanceTotals({ client_id, api_key, date_from, date_to }) {
  const body = {
    date: { from: date_from, to: date_to },
    posting_number: '',
    transaction_type: 'all',
  };
  const resp = await ozRequest({
    client_id, api_key,
    endpoint: '/v3/finance/transaction/totals',
    body,
  });
  return resp?.result || null;
}

// Сумма «расходов» БЕЗ sale_commission
function sumExpensesFromTotalsExCommission(totals) {
  if (!totals || typeof totals !== 'object') return 0;
  const fields = [
    // 'sale_commission',   // исключаем
    'processing_and_delivery',
    'refunds_and_cancellations',
    'services_amount',
    'compensation_amount',
    'money_transfer',
    'others_amount',
  ];
  let s = 0;
  for (const k of fields) {
    const v = Number(totals[k] || 0);
    if (!Number.isFinite(v)) continue;
    s += Math.abs(v);
  }
  return Math.round(s * 100) / 100;
}

// ===================== себестоимости из БД =====================
async function getCostsMapFromDB(db, chatId) {
  try {
    if (!db || !chatId) return new Map();
    const sql = `
      SELECT sp.sku::bigint AS sku, COALESCE(sp.net, 0)::numeric AS net
        FROM shop_products sp
        JOIN shops s  ON s.id = sp.shop_id
        JOIN users u  ON u.id = s.user_id
       WHERE u.chat_id = $1
    `;
    const r = await db.query(sql, [chatId]);
    const map = new Map();
    for (const row of (r.rows || [])) {
      const sku = Number(row.sku);
      const net = Number(row.net) || 0;
      if (Number.isFinite(sku)) map.set(sku, net);
    }
    return map;
  } catch (e) {
    if (process.env.DEBUG_TODAY === '1') {
      console.error('[reportText] getCostsMapFromDB error:', e);
    }
    return new Map();
  }
}

function normalizeSkuFilter(trackedSkus) {
  if (!trackedSkus) return null;
  if (Array.isArray(trackedSkus)) return trackedSkus.map(Number).filter(Number.isFinite);
  if (typeof trackedSkus === 'string') {
    return trackedSkus.split(/[,\s]+/).map(Number).filter(Number.isFinite);
  }
  if (typeof trackedSkus === 'number') return [trackedSkus];
  return null;
}

// ===================== «Заказано» из /v2/posting/fbo/list =====================
// (как было) — limit/offset; суммируем quantity и price*quantity
async function getFboOrderedStats({ client_id, api_key, date, trackedSkus = null }) {
  const from = `${date}T00:00:00.000Z`;
  const to   = `${date}T23:59:59.999Z`;

  const trackedSet = Array.isArray(trackedSkus) && trackedSkus.length
    ? new Set(trackedSkus.map(x => Number(x)))
    : null;

  const limit = 1000;
  let offset = 0;

  let totalQty = 0;
  let totalRub = 0;

  for (;;) {
    const body = {
      filter: { since: from, status: '', to },
      limit,
      offset,
      translit: true,
      with: { analytics_data: true, financial_data: true, legal_info: false },
    };

    const data = await ozRequest({
      client_id, api_key, endpoint: '/v2/posting/fbo/list', body,
    });

    const items = Array.isArray(data?.result) ? data.result : [];
    if (!items.length) break;

    for (const posting of items) {
      const status = String(posting?.status || '').toLowerCase();
      if (status === 'cancelled' || status === 'canceled') continue;

      const prods = Array.isArray(posting?.products) ? posting.products : [];
      const fin   = Array.isArray(posting?.financial_data?.products)
        ? posting.financial_data.products
        : [];

      const priceBySku = new Map();
      for (const f of fin) {
        const sku = Number(f?.product_id) || 0;
        if (!sku) continue;
        const p = Number(f?.price);
        if (Number.isFinite(p)) priceBySku.set(sku, p);
      }

      for (const p of prods) {
        const sku  = Number(p?.sku) || 0;
        const qnty = Number(p?.quantity) || 0;
        if (!qnty || !sku) continue;
        if (trackedSet && !trackedSet.has(sku)) continue;

        let unitPrice = Number(priceBySku.get(sku));
        if (!Number.isFinite(unitPrice)) unitPrice = Number(p?.price);
        if (!Number.isFinite(unitPrice)) unitPrice = 0;

        totalQty += qnty;
        totalRub += unitPrice * qnty;
      }
    }

    if (items.length < limit) break;
    offset += limit;
  }

  return { ordered_units: totalQty, revenue: Math.round(totalRub * 100) / 100 };
}

// ===================== выкупы из /v3/finance/transaction/list =====================
async function getBuyoutsFromList({
  client_id, api_key, date_from, date_to, trackedSkus = null, db = null, chatId = null,
}) {
  let count = 0;
  let amount = 0;     // ₽
  let buyoutCost = 0; // ₽ себестоимость

  const skuFilterArray = normalizeSkuFilter(trackedSkus);
  const skuFilter = skuFilterArray ? new Set(skuFilterArray) : null;

  const costsMap = await getCostsMapFromDB(db, chatId); // sku -> net

  const itemMatchesFilter = (items) => {
    if (!skuFilter) return true;
    if (!Array.isArray(items) || !items.length) return false;
    for (const it of items) {
      const skuNum = Number(it?.sku);
      if (skuFilter.has(skuNum)) return true;
    }
    return false;
  };

  let page = 1;
  const page_size = 1000;
  const includedSamples = [];
  const skippedSamples  = [];

  while (true) {
    const data = await ozRequest({
      client_id, api_key, endpoint: '/v3/finance/transaction/list',
      body: {
        filter: {
          date: { from: date_from, to: date_to },
          operation_type: [],
          posting_number: '',
          transaction_type: 'all',
        },
        page, page_size,
      },
    });

    const ops = data?.result?.operations || [];
    if (!ops.length) break;

    for (const op of ops) {
      if (op?.type !== 'orders' || op?.operation_type_name !== 'Доставка покупателю') {
        if (process.env.DEBUG_TODAY === '1' && skippedSamples.length < 5) {
          skippedSamples.push({
            t: op?.type, n: op?.operation_type_name, amount: op?.amount, accruals: op?.accruals_for_sale,
          });
        }
        continue;
      }

      const items = Array.isArray(op?.items) ? op.items : [];
      if (!itemMatchesFilter(items)) continue;

      const amt = Number(op?.amount ?? 0); // важно: берём amount
      if (amt > 0) {
        count += 1;
        amount += amt;
        // себестоимость — по всем позициям
        for (const it of items) {
          const skuNum = Number(it?.sku) || 0;
          if (!skuNum) continue;
          if (skuFilter && !skuFilter.has(skuNum)) continue;
          const net = Number(costsMap.get(skuNum) || 0);
          if (Number.isFinite(net)) buyoutCost += net;
        }
        if (process.env.DEBUG_TODAY === '1' && includedSamples.length < 5) {
          includedSamples.push({
            posting: op?.posting,
            name: op?.operation_type_name,
            amount: amt,
            items: items.map(i => ({ sku: i?.sku, name: i?.name })),
          });
        }
      } else if (process.env.DEBUG_TODAY === '1' && skippedSamples.length < 5) {
        skippedSamples.push({
          posting: op?.posting,
          name: op?.operation_type_name,
          amount: amt,
        });
      }
    }

    if (ops.length < page_size) break;
    page += 1;
  }

  if (process.env.DEBUG_TODAY === '1') {
    console.log('[buyouts-from-list]', {
      period: { from: date_from, to: date_to },
      count, amount, buyoutCost,
      sample_included: includedSamples,
      sample_skipped: skippedSamples,
    });
  }

  return { count, amount, buyoutCost };
}

// ===================== Возвраты/Отмены из /v1/returns/list =====================
// форма: { filter: { logistic_return_date: { time_from, time_to } }, limit: 500, last_id }
function isoToSecondZ(iso) {
  if (!iso) return iso;
  const i = iso.indexOf('.');
  const base = i > 0 ? iso.slice(0, i) : iso.replace(/Z?$/, '');
  return `${base}Z`;
}
async function getReturnsAndCancellations({
  client_id, api_key, date_from, date_to, trackedSkus = null,
}) {
  const time_from = isoToSecondZ(date_from); // YYYY-MM-DDTHH:MM:SSZ
  const time_to   = isoToSecondZ(date_to);   // YYYY-MM-DDTHH:MM:SSZ

  const trackedSet = Array.isArray(trackedSkus) && trackedSkus.length
    ? new Set(trackedSkus.map(Number))
    : null;

  let cancelCount = 0, cancelSum = 0;
  let returnCount = 0, returnSum = 0;

  const limit = 500;
  let last_id = 0;

  const samples = { client: [], cancel: [], unknown: [] };

  const amountFromProduct = (pr = {}) => {
    const q = Number(pr?.quantity || 0) || 1;
    const noComm = Number(pr?.price_without_commission?.price || 0);
    const raw    = Number(pr?.price?.price || 0);
    const unit   = noComm > 0 ? noComm : raw;
    return (Number.isFinite(unit) ? unit : 0) * q;
  };
  const qtyFromProduct = (pr = {}) => {
    const q = Number(pr?.quantity || 0);
    return Number.isFinite(q) && q > 0 ? q : 1;
  };
  const passesSkuFilter = (pr = {}) => {
    if (!trackedSet) return true;
    const sku = Number(pr?.sku || pr?.product_id || 0);
    return trackedSet.has(sku);
  };

  for (let page = 1; page <= 500; page++) {
    const body = {
      filter: { logistic_return_date: { time_from, time_to } },
      limit,
      last_id,
    };

    if (process.env.DEBUG_TODAY === '1' && page === 1) {
      console.log('[returns-list:request]', { body });
    }

    const data = await ozRequest({
      client_id, api_key, endpoint: '/v1/returns/list', body,
    });

    const list = Array.isArray(data?.returns) ? data.returns : [];
    if (!list.length) break;

    for (const ret of list) {
      const t = String(ret?.type || '').trim();
      const pr = ret?.product || {};
      if (!passesSkuFilter(pr)) continue;

      const amt = amountFromProduct(pr);
      const qty = qtyFromProduct(pr);

      if (t === 'ClientReturn') {
        returnCount += qty;
        returnSum   += amt;
        if (process.env.DEBUG_TODAY === '1' && samples.client.length < 3) {
          samples.client.push({ id: ret?.id, qty, amt, sku: pr?.sku, reason: ret?.return_reason_name });
        }
      } else if (t === 'Cancellation') {
        cancelCount += qty;
        cancelSum   += amt;
        if (process.env.DEBUG_TODAY === '1' && samples.cancel.length < 3) {
          samples.cancel.push({ id: ret?.id, qty, amt, sku: pr?.sku, reason: ret?.return_reason_name });
        }
      } else {
        if (process.env.DEBUG_TODAY === '1' && samples.unknown.length < 3) {
          samples.unknown.push({ id: ret?.id, type: t });
        }
      }

      // курсор last_id — берём максимальный
      if (typeof ret?.id === 'number' && ret.id > last_id) last_id = ret.id;
    }

    const hasNext = Boolean(data?.has_next);
    if (!hasNext) break;
  }

  if (process.env.DEBUG_TODAY === '1') {
    console.log('[returns-and-cancellations]', {
      period: { from: date_from, to: date_to },
      returns: { count: Math.round(returnCount), sum: Math.round(returnSum * 100) / 100 },
      cancellations: { count: Math.round(cancelCount), sum: Math.round(cancelSum * 100) / 100 },
      samples,
    });
  }

  return {
    returnsCount: Math.round(returnCount),
    returnsSum: Math.round(returnSum * 100) / 100,
    cancelsCount: Math.round(cancelCount),
    cancelsSum: Math.round(cancelSum * 100) / 100,
  };
}

// ===================== отчёт =====================
async function makeReportText(user, date, opts = {}) {
  const from = `${date}T00:00:00.000Z`;
  const to   = `${date}T23:59:59.999Z`;
  const trackedSkus = opts.trackedSkus || null;
  const db          = opts.db || null;
  const chatId      = opts.chatId || null;

  // 1) «Заказано» (шт, ₽) — из FBO постингов (как было)
  const fbo = await getFboOrderedStats({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date,
    trackedSkus,
  });
  const revenueOrdered = Number(fbo?.revenue || 0);
  const orderedUnits   = Number(fbo?.ordered_units || 0);

  // 2) Возвраты и Отмены — из /v1/returns/list (logistic_return_date + last_id)
  const rc = await getReturnsAndCancellations({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date_from: from,
    date_to:   to,
    trackedSkus,
  });
  const returnsCount = Number(rc?.returnsCount || 0);
  const returnsSum   = Number(rc?.returnsSum   || 0);
  const cancelsCount = Number(rc?.cancelsCount || 0);
  const cancelsSum   = Number(rc?.cancelsSum   || 0);

  // 3) Выкуп (шт. и ₽) + себестоимость — /v3/finance/transaction/list
  const buy = await getBuyoutsFromList({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date_from: from,
    date_to:   to,
    trackedSkus,
    db,
    chatId,
  });
  const buyoutCount  = Number(buy?.count || 0);
  const buyoutAmount = Number(buy?.amount || 0);
  const buyoutCost   = Number(buy?.buyoutCost || 0);

  // 4) Финансовая часть (totals) — только расходы (без sale_commission)
  const totals = await getFinanceTotals({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date_from: from,
    date_to:   to,
  });
  const expenses = sumExpensesFromTotalsExCommission(totals);

  // 5) Маржа:
  // margin = buyoutAmount − expenses(excl sale_commission) − returnsSum(ClientReturn) − buyoutCost
  const margin = Math.round((buyoutAmount - expenses - returnsSum - buyoutCost) * 100) / 100;

  if (process.env.DEBUG_TODAY === '1') {
    console.log('[today-finance]', {
      date, from, to,
      orderedUnits, revenueOrdered,
      returnsCount, returnsSum,
      cancelsCount, cancelsSum,
      buyoutCount, buyoutAmount, buyoutCost,
      totals_raw: totals,
      expenses_excl_sale_commission: expenses,
      margin,
    });
  }

  const lines = [];
  lines.push(`🏪 Магазин: ${user.shop_name || 'Неизвестно'}`);
  lines.push(' - - - - ');
  lines.push(`📆 Общий отчёт за: ${date}`);
  lines.push(' - - - - ');

  // Заказы: "нет", если и шт, и ₽ == 0
  if (orderedUnits === 0 && revenueOrdered === 0) {
    lines.push('📦 Заказы: нет');
  } else {
    lines.push(`📦 Заказы: ${formatInt(orderedUnits)} шт. на ${formatMoney(revenueOrdered)}₽`);
  }
  lines.push(' - - - - ');

  // Выкуплено: "нет", если и шт, и ₽ == 0
  if (buyoutCount === 0 && buyoutAmount === 0) {
    lines.push('📦 Выкуплено: нет');
  } else {
    lines.push(`📦 Выкуплено: ${formatInt(buyoutCount)} шт. на ${formatMoney(buyoutAmount)}₽`);
  }
  lines.push(' - - - - ');

  // Возвраты: "нет" если 0 и по шт, и по ₽
  if (returnsCount === 0 && returnsSum === 0) {
    lines.push('📦 Возвраты: нет');
  } else {
    lines.push(`📦 Возвраты: ${formatInt(returnsCount)} шт. на ${formatMoney(returnsSum)}₽`);
  }
  lines.push(' - - - - ');

  // Отмены: "нет" если 0 и по шт, и по ₽ (формат как в твоём варианте — без пробела перед "шт.")
  if (cancelsCount === 0 && cancelsSum === 0) {
    lines.push('📦 Отмены: нет');
  } else {
    lines.push(`📦 Отмены: ${formatInt(cancelsCount)} шт. на ${formatMoney(cancelsSum)}₽`);
  }
  lines.push(' - - - - ');

  lines.push(`💰 Маржа: ${formatMoney(margin)}₽`);
  lines.push(' - - - - ');

  return lines.map(line => `<code>${esc(line)}</code>`).join('\n');
}

async function makeTodayReportText(user, opts = {}) {
  const date = getTodayISO();
  return makeReportText(user, date, { ...(opts || {}) });
}

module.exports = { makeTodayReportText, makeReportText };
