const { getDeliveryBuyoutCount } = require('../ozon');

module.exports = (bot, db) => {
  bot.command('report_delivery', async ctx => {
    const chat_id = ctx.from.id;
    const user = (await db.query('SELECT * FROM users WHERE chat_id=$1', [chat_id])).rows[0];
    if (!user) return ctx.reply('Сначала зарегистрируйтесь через /start');

    const today = new Date().toISOString().slice(0, 10);
    const count = await getDeliveryBuyoutCount({
      client_id: user.client_id,
      api_key: user.seller_api,
      date: today
    });

    ctx.reply(`📦 Выкуплено (доставка покупателю): *${count}*`, { parse_mode: 'Markdown' });
  });
};
