const { makeYesterdayReportText } = require('../utils/reportText.js');

module.exports = (bot, db) => {
  bot.command('report_yesterday', async ctx => {
    const res = await db.query('SELECT * FROM users WHERE chat_id=$1', [ctx.from.id]);
    const user = res?.rows?.[0];
    if (!user) return ctx.reply('Сначала зарегистрируйтесь через /start');
    const text = await makeYesterdayReportText(user); // Получили текст за вчера
    await ctx.reply(text);
  });
};
