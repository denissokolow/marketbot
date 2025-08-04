const { getYesterdayISO } = require('../utils');
const { makeYesterdayReportText } = require('../reportText');

module.exports = (bot, db) => {
  bot.hears('📅 Прислать за вчера', async ctx => {
    const chat_id = ctx.from.id;
    const user = (await db.query('SELECT * FROM users WHERE chat_id=$1', [chat_id])).rows[0];
    if (!user) return ctx.reply('Сначала зарегистрируйтесь через /start');
    const date = getYesterdayISO();
    const result = await makeYesterdayReportText(user, date);
    ctx.reply(result, { parse_mode: 'Markdown' });
  });
};
