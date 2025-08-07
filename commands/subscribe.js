module.exports = (bot, db) => {
  bot.command('subscribe', async ctx => {
    await db.query('UPDATE users SET is_subscribed=true WHERE chat_id=$1', [ctx.from.id]);
    ctx.reply('Вы подписались на рассылку!');
  });
};



