const { getOzonReport } = require('../ozon');

module.exports = (bot, db) => {
  bot.hears('🔄 Прислать статус сейчас', async ctx => {
    const chat_id = ctx.from.id;
    const user = (await db.query('SELECT * FROM users WHERE chat_id=$1', [chat_id])).rows[0];

    if (!user) return ctx.reply('Сначала зарегистрируйтесь через /start');
    const today = new Date().toISOString().slice(0, 10);
    const report = await getOzonReport(user.client_id, user.seller_api, today, 'today', user.shop_name);
    ctx.reply(report, { parse_mode: 'Markdown' });
  });
};


