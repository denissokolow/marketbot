module.exports = (bot, db) => {
  bot.hears('📩 Подписаться на рассылку', async ctx => {
    const chat_id = ctx.from.id;
    await db.query('UPDATE users SET is_subscribed=true WHERE chat_id=$1', [chat_id]);
    ctx.reply('Вы подписались на рассылку!');
  });
};
