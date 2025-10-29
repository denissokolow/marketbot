// src/services/ozon/finance.js
const { ozonApiRequest } = require('./api');
const { normalizeSkuFilter } = require('./utils');

/** ===================== вспомогалки ===================== */

function toNum(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}
function isPositive(x) {
  return Number(x) > 0;
}
function shouldIncludeOp(op) {
  // Берём только «продажи/выкуп» — положительные начисления за доставку покупателю
  if (!op) return false;
  if (op.type !== 'orders') return false;
  if (op.operation_type_name !== 'Доставка покупателю') return false;
  const acc = toNum(op.accruals_for_sale, 0);
  return acc > 0;
}
function opHasTrackedSku(op, skuFilter) {
  if (!skuFilter) return true;
  const items = Array.isArray(op?.items) ? op.items : [];
  if (!items.length) return false;
  for (const it of items) {
    const sku = Number(it?.sku);
    if (skuFilter.has(sku)) return true;
  }
  return false;
}

/** ===================== себестоимости из БД ===================== */
/** Вытянуть карту себестоимостей из shop_products по пользователю (через users.chat_id) */
async function getCostsMapFromDB(db, chatId) {
  if (!db || !chatId) return new Map();
  const sql = `
    SELECT sp.sku::bigint AS sku, COALESCE(sp.net, 0)::numeric AS net, COALESCE(sp.title,'') AS title
      FROM shop_products sp
      JOIN shops s  ON s.id = sp.shop_id
      JOIN users u  ON u.id = s.user_id
     WHERE u.chat_id = $1
  `;
  const r = await db.query(sql, [chatId]);
  const netMap = new Map();   // sku -> net
  const titleMap = new Map(); // sku -> title
  for (const row of (r.rows || [])) {
    const sku = Number(row.sku);
    if (!Number.isFinite(sku)) continue;
    netMap.set(sku, toNum(row.net, 0));
    titleMap.set(sku, row.title || '');
  }
  return { netMap, titleMap };
}

/** ===================== ЛОГ разложения buyoutCost ===================== */
function logBuyoutCostBreakdown({ from, to, totalCount, buyoutCost, rows, sampleIncluded, sampleSkipped }) {
  try {
    const grouped = new Map(); // sku -> { sku, title, qty, net, subtotal }
    for (const r of rows) {
      const key = String(r.sku);
      if (!grouped.has(key)) {
        grouped.set(key, { sku: key, title: r.title || '', qty: 0, net: toNum(r.net, 0), subtotal: 0 });
      }
      const g = grouped.get(key);
      g.qty += 1; // одно слагаемое — одна «штука»
      g.subtotal += toNum(r.net, 0);
      if (!g.title && r.title) g.title = r.title;
      if (Number.isFinite(r.net)) g.net = toNum(r.net, 0); // если у SKU разные net — оставим последний виденный
    }

    const itemsTop = Array.from(grouped.values())
      .sort((a, b) => b.subtotal - a.subtotal)
      .slice(0, 30);

    const sumCheck = rows.reduce((s, r) => s + toNum(r.net, 0), 0);
    console.log('[buyout-debug]', {
      period: { from, to },
      included: { count: totalCount, sum: Math.round((buyoutCost || 0) * 100) / 100 },
      sample_included: sampleIncluded,
      sample_skipped: sampleSkipped,
    });
    console.log('[buyout-cost-breakdown]', {
      period: { from, to },
      totalCount,
      buyoutCost: Math.round((buyoutCost || 0) * 100) / 100,
      itemsTop,
      sumCheck: Math.round(sumCheck * 100) / 100,
    });
  } catch (e) {
    console.error('[buyout-cost-breakdown] log error:', e);
  }
}

/** ===================== агрегаты по выкупам ===================== */
/**
 * Достаёт список операций за период и считает:
 *  - totalCount  — кол-во положительных «Доставка покупателю» (штучный выкуп как счётчик слагаемых)
 *  - totalAmount — сумма этих положительных начислений (диагностическая выручка по операциям)
 *  - buyoutCost  — себестоимость выкупов = сумма net по каждому включённому слагаемому (SKU подставляется из БД)
 *
 * trackedSkus: number[] | Set<number> | null — если задано, фильтруем операции, где в items есть один из указанных SKU.
 */
async function getDeliveryBuyoutStats({
  client_id, api_key, date_from, date_to, trackedSkus = null, db = null, chatId = null,
}) {
  let totalCount = 0;   // шт
  let totalAmount = 0;  // ₽ (положительные accruals_for_sale)
  let buyoutCost = 0;   // ₽ (себестоимость)

  const skuFilterArray = normalizeSkuFilter(trackedSkus);
  const skuFilter = skuFilterArray ? new Set(skuFilterArray) : null;

  // карта себестоимостей и названий из БД
  const { netMap, titleMap } = await getCostsMapFromDB(db, chatId);

  // накопление для детального лога
  const costRows = [];         // массив { sku, title, net }
  const sampleIncluded = [];   // до 10 примеров включённых операций
  const sampleSkipped  = [];   // до 10 примеров отфильтрованных/пропущенных

  let page = 1;
  const page_size = 1000;

  while (true) {
    const data = await ozonApiRequest({
      client_id,
      api_key,
      endpoint: '/v3/finance/transaction/list',
      body: {
        filter: {
          date: { from: date_from, to: date_to },
          operation_type: [],
          posting_number: '',
          transaction_type: 'all',
        },
        page,
        page_size,
      },
    });

    const ops = data?.result?.operations || data?.operations || [];
    if (!Array.isArray(ops) || ops.length === 0) break;

    for (const op of ops) {
      // включаем только положительные «Доставка покупателю»
      if (!shouldIncludeOp(op)) {
        if (sampleSkipped.length < 10) {
          sampleSkipped.push({
            date: String(op?.operation_date || op?.date || ''),
            name: String(op?.operation_type_name || ''),
            accruals_for_sale: toNum(op?.accruals_for_sale, 0),
          });
        }
        continue;
      }

      // фильтр по отслеживаемым SKU
      if (!opHasTrackedSku(op, skuFilter)) {
        if (sampleSkipped.length < 10) {
          sampleSkipped.push({
            date: String(op?.operation_date || op?.date || ''),
            name: String(op?.operation_type_name || ''),
            reason: 'no tracked sku',
          });
        }
        continue;
      }

      // это «слагаемое»: +1 шт, +сумма начисления
      totalCount += 1;
      totalAmount += toNum(op?.accruals_for_sale, 0);

      const items = Array.isArray(op?.items) ? op.items : [];

      // каждую позицию операции считаем как отдельное слагаемое для себестоимости:
      for (const it of items) {
        const sku = Number(it?.sku) || 0;
        if (!sku) continue;
        if (skuFilter && !skuFilter.has(sku)) continue;

        const net = toNum(netMap.get(sku), 0);
        buyoutCost += net;

        // для логов:
        if ((process.env.DEBUG_BUYOUT === '1' || process.env.DEBUG_TODAY === '1')) {
          costRows.push({
            sku,
            title: (titleMap.get(sku) || String(it?.name || '')),
            net,
          });
        }
      }

      // пример включённой операции для лога
      if (sampleIncluded.length < 10) {
        sampleIncluded.push({
          date: String(op?.operation_date || op?.date || ''),
          name: String(op?.operation_type_name || ''),
          accruals_for_sale: toNum(op?.accruals_for_sale, 0),
          items: (op?.items || []).slice(0, 5).map(x => ({
            sku: Number(x?.sku) || 0,
            name: String(x?.name || ''),
          })),
        });
      }
    }

    if (ops.length < page_size) break;
    page += 1;
  }

  // финальные округления по копейкам
  totalAmount = Math.round(totalAmount * 100) / 100;
  buyoutCost  = Math.round(buyoutCost  * 100) / 100;

  // детальный лог
  if (process.env.DEBUG_BUYOUT === '1' || process.env.DEBUG_TODAY === '1') {
    logBuyoutCostBreakdown({
      from: date_from,
      to: date_to,
      totalCount,
      buyoutCost,
      rows: costRows,
      sampleIncluded,
      sampleSkipped,
    });
  }

  return { totalCount, totalAmount, buyoutCost };
}

/** ===================== Разбивка продаж по SKU (диагностика/детализация) ===================== */
async function getSalesBreakdownBySku({ client_id, api_key, date_from, date_to, trackedSkus = null }) {
  const skuFilterArray = normalizeSkuFilter(trackedSkus);
  const skuFilter = skuFilterArray ? new Set(skuFilterArray) : null;

  const agg = new Map(); // sku -> { sku, name, count, amount }
  let page = 1;
  const page_size = 1000;

  while (true) {
    const data = await ozonApiRequest({
      client_id,
      api_key,
      endpoint: '/v3/finance/transaction/list',
      body: {
        filter: {
          date: { from: date_from, to: date_to },
          operation_type: [],
          posting_number: '',
          transaction_type: 'all',
        },
        page,
        page_size,
      },
    });

    const ops = data?.result?.operations || data?.operations || [];
    if (!Array.isArray(ops) || ops.length === 0) break;

    for (const op of ops) {
      if (!shouldIncludeOp(op)) continue;
      if (!opHasTrackedSku(op, skuFilter)) continue;

      const acc = toNum(op?.accruals_for_sale, 0);
      if (acc <= 0) continue;

      const uniq = new Map(); // sku -> { name, occurrences }
      for (const it of (op.items || [])) {
        const sku = Number(it?.sku) || 0;
        if (!sku) continue;
        if (skuFilter && !skuFilter.has(sku)) continue;
        const name = (it?.name || '').trim();
        const cur = uniq.get(sku) || { name, occurrences: 0 };
        cur.occurrences += 1;
        if (!cur.name && name) cur.name = name;
        uniq.set(sku, cur);
      }
      if (!uniq.size) continue;

      const share = acc / uniq.size;
      for (const [sku, meta] of uniq.entries()) {
        const cur = agg.get(sku) || { sku, name: meta.name || `SKU ${sku}`, count: 0, amount: 0 };
        cur.count += meta.occurrences;
        cur.amount += share;
        agg.set(sku, cur);
      }
    }

    if (ops.length < page_size) break;
    page += 1;
  }

  return [...agg.values()].sort((a, b) => b.amount - a.amount);
}

/** ===================== Итоги (прибыль от Ozon totals c учётом buyoutCost) ===================== */
/**
 * getBuyoutAndProfit считает прибыль на базе агрегатов /v3/finance/transaction/totals:
 *   profit =
 *     buyoutAmount
 *   + sale_commission
 *   + processing_and_delivery
 *   + refunds_and_cancellations
 *   + services_amount
 *   + compensation_amount
 *   + money_transfer
 *   + others_amount
 *   - buyoutCost
 *
 * Внимание: сюда не входит сторонний учёт «суммы возвратов в рублях за сегодня»
 * (если ты вычитаешь её отдельно в тексте отчёта). Тогда не дублируй.
 */
async function getBuyoutAndProfit({ client_id, api_key, date_from, date_to, buyoutCost, buyoutAmount }) {
  const data = await ozonApiRequest({
    client_id,
    api_key,
    endpoint: '/v3/finance/transaction/totals',
    body: {
      date: { from: date_from, to: date_to },
      posting_number: '',
      transaction_type: 'all',
    },
  });

  const t = data?.result || {};
  const sale_commission           = toNum(t.sale_commission, 0);
  const processing_and_delivery   = toNum(t.processing_and_delivery, 0);
  const refunds_and_cancellations = toNum(t.refunds_and_cancellations, 0);
  const services_amount           = toNum(t.services_amount, 0);
  const compensation_amount       = toNum(t.compensation_amount, 0);
  const money_transfer            = toNum(t.money_transfer, 0);
  const others_amount             = toNum(t.others_amount, 0);

  const profit =
      toNum(buyoutAmount, 0)
    + sale_commission
    + processing_and_delivery
    + refunds_and_cancellations
    + services_amount
    + compensation_amount
    + money_transfer
    + others_amount
    - toNum(buyoutCost, 0);

  return { buyoutAmount, profit, services_amount };
}

module.exports = {
  getDeliveryBuyoutStats,
  getSalesBreakdownBySku,
  getBuyoutAndProfit,
};
