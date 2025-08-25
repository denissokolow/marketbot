// commands/adsStatsTest.js
const axios = require('axios');
const { getPerformanceToken } = require('../services/performanceApi');
const { getOzonReportFiltered } = require('../ozon');
const { getTrackedSkusForUser } = require('../utils/dbHelpers');

function parseMoney(str) {
  // "1 234,56" -> 1234.56 ; "0,00" -> 0
  if (str == null) return 0;
  return parseFloat(String(str).replace(/\s+/g, '').replace(',', '.')) || 0;
}

function format2(n) {
  if (!isFinite(n)) return '-';
  return n.toFixed(2);
}

function sumStats(rows) {
  let views = 0;
  let clicks = 0;
  let spent = 0; // moneySpent

  for (const r of rows || []) {
    views  += Number(r.views || 0);
    clicks += Number(r.clicks || 0);
    spent  += parseMoney(r.moneySpent);
  }
  return { views, clicks, spent };
}

module.exports = (bot, db) => {
  bot.command('ads_stats_test', async (ctx) => {
    // 1) берём первый магазин пользователя — для performance creds
    const rShop = await db.query(
      'SELECT id, name, performance_client_id, performance_secret FROM shops WHERE chat_id = $1 ORDER BY id LIMIT 1',
      [ctx.from.id]
    );
    const shop = rShop.rows[0];
    if (!shop) {
      return ctx.reply('❌ У вас нет магазинов. Сначала зарегистрируйте магазин.');
    }
    if (!shop.performance_client_id || !shop.performance_secret) {
      return ctx.reply('❌ В магазине не заполнены performance_client_id / performance_secret.');
    }

    // 2) достанем seller creds для revenue (users)
    const rUser = await db.query(
      'SELECT client_id, seller_api, shop_name FROM users WHERE chat_id = $1 LIMIT 1',
      [ctx.from.id]
    );
    const user = rUser.rows[0];
    if (!user?.client_id || !user?.seller_api) {
      return ctx.reply('❌ Не найдены seller client_id / api_key у пользователя.');
    }

    try {
      // 3) токен Performance
      const { token } = await getPerformanceToken({
        client_id: shop.performance_client_id,
        client_secret: shop.performance_secret,
      });

      // 4) вчерашняя дата (YYYY-MM-DD)
      const d = new Date();
      d.setDate(d.getDate() - 1);
      const iso = d.toISOString().slice(0, 10);

      // 5) Performance: суточная статистика (JSON)
      const url = `https://api-performance.ozon.ru/api/client/statistics/daily/json?dateFrom=${iso}&dateTo=${iso}`;
      const { data } = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });

      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const totals = sumStats(rows);
      const ctr = totals.views > 0 ? (totals.clicks / totals.views) * 100 : 0;

      // 6) revenueOrdered за вчера (фильтруем по отслеживаемым SKU пользователя)
      const trackedSkus = await getTrackedSkusForUser(db, ctx.from.id); // массив чисел
      const [revenueOrdered /* , orderedUnits */] = await getOzonReportFiltered({
        client_id: user.client_id,
        api_key:   user.seller_api,
        date:      iso,
        metrics:   ['revenue', 'ordered_units'],
        trackedSkus,
      });

      const revenue = Number(revenueOrdered || 0);
      const drr = revenue > 0 ? (totals.spent / revenue) * 100 : NaN;

      // 7) ответ
      const text =
        `✅ Performance статистика + ДРР (тест)\n` +
        `Магазин: ${shop.name || user.shop_name || shop.id}\n` +
        `Дата: ${iso}\n\n` +
        `Всего показов: ${totals.views}\n` +
        `Всего кликов: ${totals.clicks}\n` +
        `CTR: ${format2(ctr)}%\n` +
        `Расходы на рекламу: ${format2(totals.spent)}\n` +
        `Заказано на сумму (revenue): ${format2(revenue)}\n` +
        `ДРР: ${isNaN(drr) ? '-' : format2(drr) + '%'}\n\n` +
        `Raw JSON:\n<pre>${JSON.stringify(data, null, 2)}</pre>`;

      await ctx.replyWithHTML(text);
    } catch (e) {
      console.error('[ads_stats_test] error:', e?.response?.status, e?.response?.data || e.message);
      await ctx.reply('❌ Ошибка при запросе Performance статистики. См. логи.');
    }
  });
};
