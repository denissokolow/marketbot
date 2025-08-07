module.exports = (bot) => {
  bot.hears('📅 Прислать за вчера', async ctx => {
  const chat_id = ctx.from.id;
  const user = (await db.query('SELECT * FROM users WHERE chat_id=$1', [chat_id])).rows[0];
  if (!user) return ctx.reply('Сначала зарегистрируйтесь через /start');
  const date = getYesterdayISO();
  const report = await getOzonReport(user.client_id, user.seller_api, date, 'yesterday', user.shop_name);
  ctx.reply(report, { parse_mode: 'Markdown', reply_markup: getMainMenu().reply_markup });
});
};
