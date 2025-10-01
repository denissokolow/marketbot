// src/utils/reportText.js
const {
  getOzonReportFiltered,
  getReturnsCountFiltered,
  getReturnsSumFiltered,
  getDeliveryBuyoutStats,
  getBuyoutAndProfit,
} = require('../services/ozon');

// ===== утилиты форматирования =====
function esc(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function formatMoney(n) {
  const v = Number(n) || 0;
  return Math.round(v).toLocaleString('ru-RU');
}
function getTodayISO() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ===== первое сообщение =====
async function makeReportText(user, date, opts = {}) {
  const from = `${date}T00:00:00.000Z`;
  const to   = `${date}T23:59:59.999Z`;
  const trackedSkus = opts.trackedSkus || null;
  const db          = opts.db || null;
  const chatId      = opts.chatId || null;

  // 1) Заказы (выручка + шт)
  const metrics = await getOzonReportFiltered({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date,
    metrics: ['revenue', 'ordered_units'],
    trackedSkus,
  });
  const revenueOrdered = Number(metrics?.[0] || 0);
  const orderedUnits   = Number(metrics?.[1] || 0);

  // 2) Возвраты
  const returnsCount = await getReturnsCountFiltered({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date,
    trackedSkus,
  });
  const returnsSum = await getReturnsSumFiltered({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date,
    trackedSkus,
  });

  // 3) Выкуп + себестоимость за день (берёт net из shop_products по chat_id)
  const stats = await getDeliveryBuyoutStats({
    client_id: user.client_id,
    api_key:   user.seller_api,
    date_from: from,
    date_to:   to,
    trackedSkus,
    db,
    chatId,
  });

  // 4) Прибыль
  const { buyoutAmount, profit } = await getBuyoutAndProfit({
    client_id:  user.client_id,
    api_key:    user.seller_api,
    date_from:  from,
    date_to:    to,
    buyoutCost: stats.buyoutCost,
    buyoutAmount: stats.totalAmount,
  });

  const lines = [];
  lines.push(`🏪 Магазин: ${user.shop_name || 'Неизвестно'}`);
  lines.push(' - - - - ');
  lines.push(`📆 Общий отчёт за: ${date}`);
  lines.push(' - - - - ');
  lines.push(`📦 Заказы: ${Math.round(orderedUnits).toLocaleString('ru-RU')} шт. на ${formatMoney(revenueOrdered)}₽`);
  lines.push(' - - - - ');
  lines.push(`📦 Выкуплено: ${Math.round(stats.totalCount).toLocaleString('ru-RU')} шт. на ${formatMoney(buyoutAmount)}₽`);
  lines.push(' - - - - ');
  lines.push(`📦 Возвраты: ${Math.round(returnsCount).toLocaleString('ru-RU')} шт. на ${formatMoney(returnsSum)}₽`);
  lines.push(' - - - - ');
  lines.push(`💰 Прибыль: ${formatMoney(profit)}₽`);
  lines.push(' - - - - ');

  return lines.map(line => `<code>${esc(line)}</code>`).join('\n');
}

async function makeTodayReportText(user, opts = {}) {
  const date = getTodayISO();
  return makeReportText(user, date, { ...(opts || {}) });
}

module.exports = { makeTodayReportText, makeReportText };
