// src/utils/reportText.js
const oz = require('../services/ozon');
const {
  getOzonReportFiltered,
  getReturnsCountFiltered,
  getReturnsSumFiltered,
  getDeliveryBuyoutStats,
  // getBuyoutAndProfit — больше не нужен для today
} = require('../services/ozon');

// ===== утилиты форматирования =====
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

// Универсальный низкоуровневый вызов к Ozon Seller API (используем то, что есть в проекте)
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
      console.error('[finance-totals] request error:', e?.response?.data || e);
    }
    return null;
  }
}

// /v3/finance/transaction/totals → отдаёт агрегаты за день
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

// Сумма «расходов» из ответа totals (берём модуль значений перечисленных полей)
function sumExpensesFromTotals(totals) {
  if (!totals || typeof totals !== 'object') return 0;
  const fields = [
    'sale_commission',
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
    s += Math.abs(v); // именно "вычитаем расходы", поэтому берём модуль
  }
  return Math.round(s * 100) / 100;
}

// ===== первое сообщение (сегодняшний отчёт по новой логике) =====
async function makeReportText(user, date, opts = {}) {
  const from = `${date}T00:00:00.000Z`;
  const to   = `${date}T23:59:59.999Z`;
  const trackedSkus = opts.trackedSkus || null;
  const db          = opts.db || null;
  const chatId      = opts.chatId || null;

  // 1) Заказы (выручка + шт)
  const analytics = await getOzonReportFiltered({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date,
    metrics: ['revenue', 'ordered_units'],
    trackedSkus,
  });
  let revenueOrdered = 0, orderedUnits = 0;
  if (Array.isArray(analytics)) {
    revenueOrdered = Number(analytics[0] || 0);
    orderedUnits   = Number(analytics[1] || 0);
  } else if (analytics && typeof analytics === 'object') {
    revenueOrdered = Number(analytics.revenue || 0);
    orderedUnits   = Number(analytics.ordered_units || 0);
  }

  // 2) Возвраты (шт., ₽)
  const returnsCount = Number(await getReturnsCountFiltered({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date,
    trackedSkus,
  })) || 0;

  const returnsSum = Number(await getReturnsSumFiltered({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date,
    trackedSkus,
  })) || 0;

  // 3) Выкуп (шт.) — из постингов delivered
  const stats = await getDeliveryBuyoutStats({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date_from: from,
    date_to:   to,
    trackedSkus,
    db,
    chatId,
  }) || { totalCount: 0 };

  const buyoutCount = Number(stats.totalCount || 0);

  // 4) Финансовая часть: totals → выкупная выручка и расходы
  const totals = await getFinanceTotals({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date_from: from,
    date_to:   to,
  });

  const accrualsForSale = Number(totals?.accruals_for_sale || 0); // «выкуплено на сумму» (₽)
  const expenses        = sumExpensesFromTotals(totals);          // сумма всех расходов (₽)

  // 5) Прибыль по новой формуле:
  //    profit = accruals_for_sale - expenses - returnsSum
  const profitFinal = Math.round((accrualsForSale - expenses - returnsSum) * 100) / 100;

  if (process.env.DEBUG_TODAY === '1') {
    console.log('[today-finance-totals]', {
      date, from, to,
      analytics_raw: analytics,
      returnsCount, returnsSum,
      buyoutCount,
      totals_raw: totals,
      accrualsForSale,
      expenses,
      profitFinal,
    });
  }

  const lines = [];
  lines.push(`🏪 Магазин: ${user.shop_name || 'Неизвестно'}`);
  lines.push(' - - - - ');
  lines.push(`📆 Общий отчёт за: ${date}`);
  lines.push(' - - - - ');
  lines.push(`📦 Заказы: ${formatInt(orderedUnits)} шт. на ${formatMoney(revenueOrdered)}₽`);
  lines.push(' - - - - ');
  lines.push(`📦 Выкуплено: ${formatInt(buyoutCount)} шт. на ${formatMoney(accrualsForSale)}₽`);
  lines.push(' - - - - ');
  lines.push(`📦 Возвраты: ${formatInt(returnsCount)} шт. на ${formatMoney(returnsSum)}₽`);
  lines.push(' - - - - ');
  lines.push(`💰 Прибыль: ${formatMoney(profitFinal)}₽`);
  lines.push(' - - - - ');

  return lines.map(line => `<code>${esc(line)}</code>`).join('\n');
}

async function makeTodayReportText(user, opts = {}) {
  const date = getTodayISO();
  return makeReportText(user, date, { ...(opts || {}) });
}

module.exports = { makeTodayReportText, makeReportText };
