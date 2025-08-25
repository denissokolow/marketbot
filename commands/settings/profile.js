// commands/settings/profile.js
const { Markup } = require('telegraf');

module.exports = ({ bot, db, shared, data }) => {
  const { CB, sendOrEdit, backRow } = shared;

  bot.action(CB.PROFILE, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await data.getUserByChat(db, ctx.from.id);
    const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || '—';
    const sub = user?.is_subscribed ? 'активна' : 'выключена';

    const text =
      '👤 Профиль\n' +
      `Имя: ${name}\n` +
      `Статус подписки: ${sub}`;

    await sendOrEdit(ctx, text, Markup.inlineKeyboard([backRow(CB.MAIN)]));
  });
};
