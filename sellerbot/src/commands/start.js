module.exports.register = (bot, { logger }) => {
  bot.start(async (ctx) => {
    await ctx.reply('Привет! Бот готов. Попробуй /report_yesterday');
    logger.info({ user: ctx.from?.id }, 'start');
  });
};
