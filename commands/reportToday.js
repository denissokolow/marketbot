// commands/reportToday.js
const { makeTodayReportText } = require('../utils/reportText.js');

module.exports = (bot, db) => {
  bot.command('report_today', async ctx => {
    const res = await db.query('SELECT * FROM users WHERE chat_id=$1', [ctx.from.id]);
    const user = res?.rows?.[0];
    if (!user) return ctx.reply('Сначала зарегистрируйтесь через /start');

    const text = await makeTodayReportText(user);
    await ctx.reply(text, { parse_mode: 'HTML' });
  });
};



