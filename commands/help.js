module.exports = (bot) => {
  bot.hears('❓ Помощь', ctx => {
    ctx.reply('Для помощи обратитесь к администратору.');
  });
};
