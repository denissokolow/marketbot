// commands/reportToday.js
const { getOzonReport, getReturnsCount, formatMoney } = require('../ozon');

module.exports = (bot, db) => {
  bot.hears('🔄 Прислать статус сейчас', async ctx => {
    const chat_id = ctx.from.id;
    const user = (await db.query('SELECT * FROM users WHERE chat_id=$1', [chat_id])).rows[0];
    if (!user) return ctx.reply('Сначала зарегистрируйтесь через /start');

    const date = new Date().toISOString().slice(0, 10);
    const metrics = ["revenue", "ordered_units"];
    const values = await getOzonReport({ client_id: user.client_id, api_key: user.seller_api, date, metrics });
    const returnsCount = await getReturnsCount({ client_id: user.client_id, api_key: user.seller_api, date });

    if (!values) {
      return ctx.reply(
        `🏪 Магазин: *${user.shop_name || "Неизвестно"}*\n📅 Отчет за ${date}\n\nНет данных за этот день.`,
        { parse_mode: 'Markdown' }
      );
    }

    const result =
      `🏪 Магазин: *${user.shop_name || "Неизвестно"}*\n\n` +
      `🕒 Отчет за *${date}*\n\n` +
      `💰 Заказано на сумму: *${formatMoney(values[0])}₽*\n\n` +
      `📦 Заказано товаров: *${values[1] ?? '-'}*\n\n` +
      `🔄 Возвраты: *${returnsCount}*\n\n`;

    ctx.reply(result, { parse_mode: 'Markdown' });
  });
};
