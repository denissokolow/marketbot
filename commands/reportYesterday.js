// commands/reportYesterday.js
const { makeYesterdayReportText, makeYesterdaySkuBreakdownText } = require('../utils/reportText.js');
const { makeMtdPerSkuText } = require('../utils/reportMtdSku.js');
const { getTrackedSkusForUser } = require('../utils/dbHelpers.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPING_PAUSE_MS = Number(process.env.REPORT_TYPING_PAUSE_MS || 1200);
const BETWEEN_MSG_MS  = Number(process.env.REPORT_BETWEEN_MSG_MS  || 1800);

module.exports = (bot, db) => {
  bot.command('report_yesterday', async (ctx) => {
    try {
      const chatId = ctx.from.id;

      const r = await db.query('SELECT * FROM users WHERE chat_id=$1', [chatId]);
      const user = r?.rows?.[0];
      if (!user) {
        await ctx.reply('Сначала зарегистрируйтесь через /start');
        return;
      }

      const trackedSkus = await getTrackedSkusForUser(db, chatId);

      // ------- Сообщение №1: сводка за вчера -------
      const text1 = await makeYesterdayReportText(user, { trackedSkus, db, chatId });
      if (typeof text1 === 'string' && text1.trim()) {
        await ctx.reply(text1, { parse_mode: 'HTML', disable_web_page_preview: true });
      }

      await ctx.sendChatAction('typing');
      await sleep(BETWEEN_MSG_MS);

      // ------- Сообщение №2: разбивка по SKU за вчера -------
      const text2 = await makeYesterdaySkuBreakdownText(user, { trackedSkus, db, chatId });
      if (typeof text2 === 'string' && text2.trim()) {
        await ctx.reply(text2, { parse_mode: 'HTML', disable_web_page_preview: true });
      }

      await ctx.sendChatAction('typing');
      await sleep(BETWEEN_MSG_MS);

      // ------- Сообщение №3: MTD по SKU (с начала месяца до конца вчера) -------
      if (process.env.DEBUG_MTD_PARAMS === '1') {
        console.log('[report_yesterday] makeMtdPerSkuText params =', {
          hasDb: !!db,
          hasQuery: typeof db?.query === 'function',
          chatId,
          trackedCount: Array.isArray(trackedSkus) ? trackedSkus.length : 0,
        });
      }

      const text3 = await makeMtdPerSkuText(user, {
        trackedSkus,
        db,        // ВАЖНО: передаём db для получения себестоимости
        chatId,    // ВАЖНО: передаём chatId для правильного выборочного запроса
      });

      if (Array.isArray(text3)) {
        for (const chunk of text3) {
          const s = typeof chunk === 'string' ? chunk : '';
          if (!s.trim()) continue;
          await ctx.reply(s, { parse_mode: 'HTML', disable_web_page_preview: true });
          await ctx.sendChatAction('typing');
          await sleep(TYPING_PAUSE_MS);
        }
      } else if (typeof text3 === 'string' && text3.trim()) {
        await ctx.reply(text3, { parse_mode: 'HTML', disable_web_page_preview: true });
      } else {
        await ctx.reply('<code>Нет данных для MTD-отчёта.</code>', { parse_mode: 'HTML' });
      }
    } catch (err) {
      console.error('[report_yesterday] error:', err?.response?.data || err);
      const msg = err?.message ? `Ошибка: ${err.message}` : 'Ошибка при формировании отчёта.';
      try {
        await ctx.reply(msg);
      } catch {}
    }
  });
};
