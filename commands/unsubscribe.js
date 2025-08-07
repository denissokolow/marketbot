module.exports = (bot, db) => {
  bot.command('unsubscribe', async ctx => {
    await db.query('UPDATE users SET is_subscribed=false WHERE chat_id=$1', [ctx.from.id]);
    ctx.reply('Вы отписались от рассылки.');
  });
};



