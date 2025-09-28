// commands/reportYesterday.js
const { makeYesterdayReportText, makeYesterdaySkuBreakdownText } = require('../utils/reportText');

/**
 * /report_yesterday — первое сообщение всегда.
 * Второе (разбивка по товарам) — только при активной подписке (users.is_subscribed = true).
 */
module.exports = function registerReportYesterday(bot, db) {
  bot.command('report_yesterday', async (ctx) => {
    const chatId = String(ctx.chat.id);

    try {
      // 1) Пользователь (креды озон + статус подписки)
      const ures = await db.query(
        `SELECT client_id, seller_api, shop_name, is_subscribed
           FROM users
          WHERE chat_id = $1
          LIMIT 1`,
        [chatId]
      );
      if (!ures.rowCount) {
        await ctx.reply('Пользователь не найден. Сначала выполните /register');
        return;
      }
      const u = ures.rows[0];
      const user = {
        client_id: u.client_id,
        seller_api: u.seller_api,
        shop_name: u.shop_name || 'Магазин',
      };

      // 2) Отслеживаемые SKU
      const sres = await db.query(
        `SELECT sp.sku::bigint AS sku
           FROM shop_products sp
           JOIN shops s ON s.id = sp.shop_id
          WHERE s.chat_id = $1
            AND sp.tracked = TRUE`,
        [chatId]
      );
      const trackedSkus = sres.rows.map(r => Number(r.sku)).filter(Number.isFinite);

      // 3) Первое сообщение — всегда
      const text1 = await makeYesterdayReportText(user, {
        trackedSkus,
        db,
        chatId,
      });
      await ctx.replyWithHTML(text1, { disable_web_page_preview: true });

      // 4) Второе сообщение — только если есть подписка
      if (u.is_subscribed === true) {
        const text2 = await makeYesterdaySkuBreakdownText(user, {
          trackedSkus,
          db,
          chatId,
        });
        await ctx.replyWithHTML(text2, { disable_web_page_preview: true });
      }

    } catch (err) {
      console.error('[command /report_yesterday] error:', err?.response?.data || err);
      await ctx.reply('Не удалось сформировать отчёт за вчера.');
    }
  });
};
