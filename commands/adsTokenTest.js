// commands/adsTokenTest.js
const { getPerformanceToken } = require('../services/performanceApi');

module.exports = (bot, db) => {
  bot.command('ads_token_test', async (ctx) => {
    // Берём любой (первый) магазин пользователя
    const r = await db.query(
      'SELECT id, name, performance_client_id, performance_secret FROM shops WHERE chat_id = $1 ORDER BY id LIMIT 1',
      [ctx.from.id]
    );
    const shop = r.rows[0];
    if (!shop) {
      return ctx.reply('У вас нет магазинов. Сначала зарегистрируйте магазин.');
    }
    if (!shop.performance_client_id || !shop.performance_secret) {
      return ctx.reply('В магазине не заполнены performance_client_id / performance_secret.');
    }

    try {
      const { token, expiresIn } = await getPerformanceToken({
        client_id: shop.performance_client_id,
        client_secret: shop.performance_secret,
      });

      const preview = token.slice(0, 8);
      await ctx.reply(
        `✅ Токен получен.\n` +
        `Магазин: ${shop.name || shop.id}\n` +
        `access_token: ${preview}…\n` +
        `expires_in: ${expiresIn || '—'}`
      );
    } catch (e) {
      await ctx.reply('❌ Не удалось получить токен Performance API. Подробности в логах.');
    }
  });
};
