// commands/reportYesterday.js
const { makeYesterdayReportText } = require('../utils/reportText.js');
const { getTrackedSkusForUser } = require('../utils/dbHelpers.js');

module.exports = (bot, db) => {
  bot.command('report_yesterday', async ctx => {
    const r = await db.query('SELECT * FROM users WHERE chat_id=$1', [ctx.from.id]);
    const user = r?.rows?.[0];
    if (!user) return ctx.reply('Сначала зарегистрируйтесь через /start');

    const trackedSkus = await getTrackedSkusForUser(db, ctx.from.id);
    console.log('[report_yesterday] trackedSkus ->', trackedSkus);

    const text = await makeYesterdayReportText(user, {
      trackedSkus,
      db,               // прокидываем для себестоимости net
      chatId: ctx.from.id,
    });
    await ctx.reply(text, { parse_mode: 'HTML' });

    await ctx.reply('📊 Дополнительный отчёт сформирован', { parse_mode: 'HTML' });
  });
};
