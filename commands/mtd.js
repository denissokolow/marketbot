// commands/mtd.js
const { makeMtdPerSkuText } = require('../utils/reportMtdSku');

async function loadUserCreds(db, chatId) {
  // базовые креды берём из users
  const q = `
    SELECT
      u.client_id,
      u.seller_api,
      COALESCE(u.shop_name, s.name, 'Неизвестно') AS shop_name
    FROM users u
    LEFT JOIN shops s ON s.chat_id = u.chat_id
    WHERE u.chat_id = $1
    ORDER BY u.updated_at DESC NULLS LAST, u.id DESC
    LIMIT 1
  `;
  const r = await db.query(q, [String(chatId)]);
  return r.rowCount ? r.rows[0] : null;
}

async function loadTrackedSkus(db, chatId) {
  const sql = `
    SELECT sp.sku::bigint AS sku
    FROM shop_products sp
    JOIN shops s ON s.id = sp.shop_id
    WHERE s.chat_id = $1
      AND sp.tracked = TRUE
    ORDER BY sp.sku
  `;
  const r = await db.query(sql, [String(chatId)]);
  return r.rows.map(x => Number(x.sku)).filter(Number.isFinite);
}

module.exports = (bot, db) => {
  bot.command('mtd', async (ctx) => {
    try {
      const chatId = ctx.chat?.id;
      if (!chatId) return ctx.reply('Не удалось определить чат.');

      const userRow = await loadUserCreds(db, chatId);
      if (!userRow) {
        return ctx.reply('Пользователь не найден. Нужна регистрация (/start).');
      }
      if (!userRow.seller_api || !userRow.client_id) {
        return ctx.reply('Нет API-ключа или client_id в профиле. Проверь /register.');
      }

      const trackedSkus = await loadTrackedSkus(db, chatId);
      if (!trackedSkus.length) {
        return ctx.reply('Нет отслеживаемых товаров для MTD-отчёта.');
      }

      const user = {
        shop_name: userRow.shop_name || 'Неизвестно',
        client_id: userRow.client_id,
        seller_api: userRow.seller_api, // ключ берём из users.seller_api
      };

      await ctx.replyWithChatAction('typing');

      const text = await makeMtdPerSkuText(user, {
        trackedSkus,
        db,
        chatId: String(chatId), // нужно для вытягивания performance-ключей внутри отчёта
      });

      return ctx.replyWithHTML(text, { disable_web_page_preview: true });
    } catch (e) {
      console.error('[command /mtd] error:', e?.response?.data || e);
      return ctx.reply('Не удалось сформировать MTD-отчёт по SKU.');
    }
  });
};
