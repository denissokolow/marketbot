// src/commands/lastM.js
const { sendWelcomeCard } = require('../utils/replies');
const { makeLastMPerSkuText } = require('../utils/reportLastMsku');

async function fetchTrackedSkus(pool, chatId) {
  // сначала пробуем только tracked = TRUE, если колонки нет — берём все
  try {
    const r = await pool.query(`
      SELECT sp.sku::bigint AS sku
        FROM shop_products sp
        JOIN shops s ON s.id = sp.shop_id
        JOIN users u ON u.id = s.user_id
       WHERE u.chat_id = $1
         AND sp.tracked = TRUE
    `, [chatId]);
    return (r.rows || []).map(x => Number(x.sku)).filter(Number.isFinite);
  } catch (e) {
    if (e?.code !== '42703') throw e;
    const r2 = await pool.query(`
      SELECT sp.sku::bigint AS sku
        FROM shop_products sp
        JOIN shops s ON s.id = sp.shop_id
        JOIN users u ON u.id = s.user_id
       WHERE u.chat_id = $1
    `, [chatId]);
    return (r2.rows || []).map(x => Number(x.sku)).filter(Number.isFinite);
  }
}

function register(bot, { pool, logger }) {
  bot.command(['lastM'], async (ctx) => {
    const chatId = ctx.from?.id;
    try {
      // пользователь есть?
      const u = await pool.query('SELECT id FROM users WHERE chat_id=$1 LIMIT 1', [chatId]);
      if (!u.rowCount) { await sendWelcomeCard(ctx); return; }

      // магазин + Ozon креды
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

      const trackedSkus = await fetchTrackedSkus(pool, chatId);
      if (!trackedSkus.length) {
        await ctx.reply('⚠️ Нет отслеживаемых товаров для отчёта.');
        return;
      }

      const text = await makeLastMPerSkuText(user, { trackedSkus, db: pool, chatId });
      await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
      (logger?.error ? logger.error(e, '/lastM error') : console.error(e));
      await ctx.reply('⚠️ Не удалось сформировать отчёт за прошлый месяц.');
    }
  });
}

module.exports = register;
module.exports.register = register;
