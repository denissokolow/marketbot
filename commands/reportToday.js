// commands/reportToday.js
const { makeTodayReportText } = require('../utils/reportText.js');
const { getTrackedSkusForUser } = require('../utils/dbHelpers.js');

module.exports = (bot, db) => {
  bot.command('report_today', async ctx => {
    const r = await db.query('SELECT * FROM users WHERE chat_id=$1', [ctx.from.id]);
    const user = r?.rows?.[0];
    if (!user) return ctx.reply('Сначала зарегистрируйтесь через /start');

    // массив SKU (может быть пустым — это ок, покажем нули)
    const trackedSkus = await getTrackedSkusForUser(db, ctx.from.id);
    console.log('[report_today] trackedSkus ->', trackedSkus);

    const text = await makeTodayReportText(user, {
      trackedSkus,
      db,               // прокидываем для себестоимости net
      chatId: ctx.from.id,
    });
    await ctx.reply(text, { parse_mode: 'HTML' });
  });
};


