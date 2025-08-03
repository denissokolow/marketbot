module.exports = (bot, db) => {
  bot.hears('🔕 Отписаться от рассылки', async ctx => {
    const chat_id = ctx.from.id;
    await db.query('UPDATE users SET is_subscribed=false WHERE chat_id=$1', [chat_id]);
    ctx.reply('Вы отписались от рассылки.');
  });
};
