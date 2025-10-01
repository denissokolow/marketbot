// src/commands/report.js
const { sendWelcomeCard } = require('../utils/replies');
const { makeTodayReportText } = require('../utils/reportText');

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
