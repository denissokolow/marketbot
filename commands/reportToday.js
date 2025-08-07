const { makeTodayReportText } = require('../utils/reportText.js');

module.exports = (bot, db) => {
  bot.command('report_today', async ctx => {
    const user = (await db.query('SELECT * FROM users WHERE chat_id=$1', [ctx.from.id])).rows[0];
    if (!user) return ctx.reply('Сначала зарегистрируйтесь через /start');
    const today = new Date().toISOString().slice(0, 10);
    const text = await makeTodayReportText(user, today);
    await ctx.reply(text, { parse_mode: 'Markdown' });
  });
};
