// sellerbot/src/commands/yesterday.js
const { sendWelcomeCard } = require('../utils/replies');
const { makeYesterdaySummaryText } = require('../utils/reportTextYest');
const { makeYesterdayPerSkuText } = require('../utils/reportYestSku');

function register(bot, { pool, logger }) {
  bot.command(['yesterday'], async (ctx) => {
    const chatId = ctx.from?.id;

    try {
      // 0) есть ли пользователь
      const u = await pool.query('SELECT id FROM users WHERE chat_id = $1 LIMIT 1', [chatId]);
      if (!u.rowCount) { await sendWelcomeCard(ctx); return; }

      // 1) берём последний магазин пользователя (ozon_client_id / ozon_api_key)
      const s = await pool.query(
        `SELECT s.name, s.ozon_client_id, s.ozon_api_key
           FROM shops s
           JOIN users u ON u.id = s.user_id
          WHERE u.chat_id = $1
          ORDER BY s.created_at DESC NULLS LAST, s.id DESC
          LIMIT 1`,
        [chatId]
      );
      if (!s.rowCount || !s.rows[0].ozon_client_id || !s.rows[0].ozon_api_key) {
        await ctx.reply('⚠️ Заполните Client-Id и Api-Key Ozon в магазине.');
        return;
      }

      const user = {
        client_id:  s.rows[0].ozon_client_id,
        seller_api: s.rows[0].ozon_api_key,
        shop_name:  s.rows[0].name || '',
      };

      // 2) первое сообщение — общая сводка за вчера
      const summary = await makeYesterdaySummaryText(user, { db: pool, chatId });
      await ctx.reply(summary, { parse_mode: 'HTML', disable_web_page_preview: true });

      // 3) второе сообщение — по каждому SKU (включается флагом, по умолчанию включено)
      const enablePerSku = process.env.ENABLE_YESTERDAY_PER_SKU !== '0';
      if (enablePerSku) {
        try {
          const perSku = await makeYesterdayPerSkuText(user, { db: pool, chatId });
          await ctx.reply(perSku, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (e) {
          (logger?.warn ? logger.warn(e, '[yesterday per-sku] error') : console.warn('[yesterday per-sku] error:', e?.message || e));
          // не падаем, если второе сообщение не удалось сформировать
        }
      }
    } catch (e) {
      (logger?.error ? logger.error(e, '/yesterday error') : console.error('/yesterday error', e));
      await ctx.reply('⚠️ Не удалось сформировать отчёт за вчера.');
    }
  });
}

module.exports = register;
module.exports.register = register;
