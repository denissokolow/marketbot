// commands/report_yesterday.js
const { makeYesterdayReportText, makeYesterdaySkuBreakdownText } = require('../utils/reportText.js');
const { getTrackedSkusForUser } = require('../utils/dbHelpers.js');

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

module.exports = (bot, db) => {
  bot.command('report_yesterday', async (ctx) => {
    try {
      const r = await db.query('SELECT * FROM users WHERE chat_id=$1 LIMIT 1', [ctx.from.id]);
      const user = r?.rows?.[0];
      if (!user) return ctx.reply('Сначала зарегистрируйтесь через /start');

      const trackedSkus = await getTrackedSkusForUser(db, ctx.from.id); // без фильтра по остатку

      // Сообщение №1
     
      const text1 = await makeYesterdayReportText(user, { trackedSkus, db, chatId: ctx.from.id });
      await ctx.reply(text1, { parse_mode: 'HTML', disable_web_page_preview: true });

      // Показываем "typing" и ждём ~3 секунды перед вторым сообщением
      for (let i = 0; i < 3; i++) {
        await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');
        await sleep(1000);
      }

      // Сообщение №2
      const text2 = await makeYesterdaySkuBreakdownText(user, { trackedSkus, db, chatId: ctx.from.id });
      await ctx.reply(text2, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
      console.error('[report_yesterday] error:', e?.response?.data || e);
      await ctx.reply('Произошла ошибка при формировании отчёта за вчера. Попробуйте ещё раз.');
    }
  });
};
