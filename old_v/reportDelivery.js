const { getDeliveryBuyoutStats } = require('../ozon');
const { getYesterdayISO } = require('../utils/utils');

module.exports = (bot, db) => {
  bot.command('report_delivery', async ctx => {
    const res = await db.query('SELECT * FROM users WHERE chat_id=$1', [ctx.from.id]);
    const user = res?.rows?.[0];
    if (!user) return ctx.reply('Сначала зарегистрируйтесь через /start');

    const date = getYesterdayISO(); // вида YYYY-MM-DD
    const from = `${date}T00:00:00.000Z`;
    const to   = `${date}T23:59:59.999Z`;

    try {
      const { count, amount } = await getDeliveryBuyoutStats({
        client_id: user.client_id,
        api_key: user.seller_api,
        date_from: from,
        date_to: to
      });

      await ctx.reply(
        `📦 Выкуп: *${count}*\n💰 Сумма: *${amount.toFixed(2)}₽*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error(err);
      await ctx.reply('Ошибка при получении статистики.');
    }
  });
};