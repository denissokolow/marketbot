const { makeYesterdayReportText, makeYesterdaySkuBreakdownText } = require('../utils/reportText.js');
const { getTrackedSkusForUser } = require('../utils/dbHelpers.js');

module.exports = (bot, db) => {
  bot.command('report_yesterday', async (ctx) => {
    const r = await db.query('SELECT * FROM users WHERE chat_id=$1', [ctx.from.id]);
    const user = r?.rows?.[0];
    if (!user) return ctx.reply('Сначала зарегистрируйтесь через /start');

    const trackedSkus = await getTrackedSkusForUser(db, ctx.from.id);

    // Сообщение №1 (моноширный <pre>)
    const text1 = await makeYesterdayReportText(user, { trackedSkus, db, chatId: ctx.from.id });
    await ctx.reply(text1, { parse_mode: 'HTML', disable_web_page_preview: true });

    // Сообщение №2 (моноширный <pre>)
    const text2 = await makeYesterdaySkuBreakdownText(user, { trackedSkus });
    await ctx.reply(text2, { parse_mode: 'HTML', disable_web_page_preview: true });
  });
};
