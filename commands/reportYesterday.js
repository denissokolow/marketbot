const { makeYesterdayReportText } = require('../utils/reportText.js');
const { getYesterdayISO } = require('../utils/utils.js');

module.exports = (bot, db) => {
  bot.command('report_yesterday', async ctx => {
    const user = (await db.query('SELECT * FROM users WHERE chat_id=$1', [ctx.from.id])).rows[0];
    if (!user) return ctx.reply('Сначала зарегистрируйтесь через /start');
    const date = getYesterdayISO();
    const text = await makeYesterdayReportText(user, date);
    await ctx.reply(text, { parse_mode: 'Markdown' });
  });
};
