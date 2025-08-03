// commands/register.js
const registrationStep = {};

module.exports = (bot, db) => {
  bot.start(async ctx => {
    registrationStep[ctx.from.id] = {};
    await ctx.reply('Для регистрации введите ваш client_id и api_key через пробел:');
  });

  bot.hears(/^(\d+) (.+)$/i, async ctx => {
    const chat_id = ctx.from.id;
    registrationStep[chat_id] = {
      client_id: ctx.match[1],
      seller_api: ctx.match[2],
      first_name: ctx.from.first_name || '',
      last_name: ctx.from.last_name || ''
    };
    await ctx.reply('Введите название вашего магазина (как на Ozon):');
  });

  bot.on('text', async ctx => {
    const chat_id = ctx.from.id;
    if (
      registrationStep[chat_id] &&
      registrationStep[chat_id].client_id &&
      !ctx.message.text.startsWith('/')
      && !['🔄 Прислать статус сейчас', '❓ Помощь', '📩 Подписаться на рассылку', '🔕 Отписаться от рассылки'].includes(ctx.message.text)
    ) {
      const {client_id, seller_api, first_name, last_name} = registrationStep[chat_id];
      const shop_name = ctx.message.text.trim();
      await db.query(
        `INSERT INTO users (chat_id, client_id, seller_api, is_subscribed, first_name, last_name, shop_name)
         VALUES ($1, $2, $3, true, $4, $5, $6)
         ON CONFLICT (chat_id) DO UPDATE SET client_id = $2, seller_api = $3, first_name = $4, last_name = $5, shop_name = $6`,
        [chat_id, client_id, seller_api, first_name, last_name, shop_name]
      );
      delete registrationStep[chat_id];
      await ctx.reply(
        `Вы успешно зарегистрированы и подписаны на рассылку!\nВаш магазин: *${shop_name}*`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
  });
};
