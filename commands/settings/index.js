const shared = require('./_shared');
const data   = require('./data');

module.exports = (bot, db) => {
  // /settings — корневое меню
  bot.command('settings', async (ctx) => {
    shared.costInputState.delete(ctx.from.id); // сброс ожидания ввода цены
    await shared.sendOrEdit(ctx, '⚙️ Меню', shared.mainKeyboard());
  });

  // Наверх (из любого экрана)
  bot.action(shared.CB.MAIN, async (ctx) => {
    shared.costInputState.delete(ctx.from.id);
    await ctx.answerCbQuery();
    await shared.sendOrEdit(ctx, '⚙️ Меню', shared.mainKeyboard());
  });

  // Подключаем разделы (они сами навесят свои action/handlers)
  require('./profile')({ bot, db, shared, data });
  require('./shops')({ bot, db, shared, data });
  require('./costs')({ bot, db, shared, data });

  // no-op для "стр. X/Y"
  bot.action('noop', async (ctx) => ctx.answerCbQuery());
};