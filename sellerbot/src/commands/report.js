const { todayRangeISO } = require('../utils/dates');

module.exports.register = (bot, { pool, logger, config }) => {
  bot.command('report', async (ctx) => {
    const chatId = ctx.chat?.id;
    const { start, end } = todayRangeISO(config.timezone); // границы "сегодня" в UTC
    try {
      // TODO: собрать статистику за сегодня [start..end) и отправить
      await ctx.reply(`Заглушка: отчёт за сегодня (${start} → ${end}).`);
    } catch (e) {
      logger.error(e, 'report failed');
      await ctx.reply('Что-то пошло не так при формировании отчёта 😔');
    }
  });
};
