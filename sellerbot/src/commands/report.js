// src/commands/report.js
const { sendWelcomeCard } = require('../utils/replies');
const { makeTodayReportText } = require('../utils/reportText');

const oz = require('../services/ozon');
const dates = require('../utils/dates');
const getTodayISO = (typeof dates?.getTodayISO === 'function')
  ? dates.getTodayISO
  : () => {
      // YYYY-MM-DD в Europe/Moscow
      const now = new Date();
      const parts = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(now);
      const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
      return `${m.year}-${m.month}-${m.day}`;
    };

module.exports.register = (bot, { pool, logger }) => {
  bot.command('report', async (ctx) => {
    const chatId = ctx.from?.id;

    try {
      // пользователь?
      const u = await pool.query('SELECT id FROM users WHERE chat_id=$1 LIMIT 1', [chatId]);
      if (!u.rowCount) {
        await sendWelcomeCard(ctx);
        return;
      }

      // 1 пользователь -> 1 магазин
      const s = await pool.query(
        `SELECT s.name, s.ozon_client_id, s.ozon_api_key
           FROM shops s
           JOIN users u ON u.id = s.user_id
          WHERE u.chat_id = $1
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT 1`,
        [chatId]
      );
      if (!s.rowCount) {
        await sendWelcomeCard(ctx);
        return;
      }
      // ВКЛЮЧАЕМ лог по флагу .env: DEBUG_TODAY=1
if (process.env.DEBUG_TODAY === '1') {
  try {
    // берём последний магазин пользователя и его Ozon-креды
    const s = await pool.query(
      `SELECT s.name, s.ozon_client_id, s.ozon_api_key
         FROM shops s
         JOIN users u ON u.id = s.user_id
        WHERE u.chat_id = $1
        ORDER BY s.created_at DESC NULLS LAST, s.id DESC
        LIMIT 1`,
      [ctx.from.id]
    );

    if (s.rowCount) {
      const client_id = s.rows[0].ozon_client_id;
      const api_key   = s.rows[0].ozon_api_key;

      const date = getTodayISO();                  // YYYY-MM-DD (Europe/Moscow)
      const from = `${date}T00:00:00.000Z`;
      const to   = `${date}T23:59:59.999Z`;

      // 1) Заказы/выручка (часто массив [revenue, ordered_units])
      const analytics = await oz.getOzonReportFiltered({
        client_id, api_key, date, metrics: ['revenue','ordered_units'],
      });

      // 2) Возвраты
      const returnsCount = await oz.getReturnsCountFiltered({ client_id, api_key, date });
      const returnsSum   = await oz.getReturnsSumFiltered({ client_id, api_key, date });

      // 3) Выкуп + прибыль
      const buyoutStats = await oz.getDeliveryBuyoutStats({
        client_id, api_key, date_from: from, date_to: to, db: pool, chatId: ctx.from.id,
      });
      const bp = await oz.getBuyoutAndProfit({
        client_id, api_key, date_from: from, date_to: to, db: pool, chatId: ctx.from.id,
      });

      console.log('[today-debug]', {
        date, from, to,
        analytics_raw: analytics,
        returnsCount, returnsSum,
        buyoutStats,
        buyoutAndProfit: bp,
      });
    } else {
      console.log('[today-debug] no shop creds for chat', ctx.from.id);
    }
  } catch (e) {
    console.error('[today-debug] error:', e?.response?.data || e);
  }
}

      const userLike = {
        client_id: s.rows[0].ozon_client_id,
        seller_api: s.rows[0].ozon_api_key,
        shop_name: s.rows[0].name || '',
      };

      // trackedSkus не используем — считаем по всем
      const text = await makeTodayReportText(userLike, { db: pool, chatId });

      await ctx.reply(text, { parse_mode: 'HTML' });
    } catch (e) {
      logger?.error?.(e, '/report error');
      await ctx.reply('⚠️ Не удалось сформировать отчёт. Попробуйте позже.');
    }
  });
};
