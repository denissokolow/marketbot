// commands/register.js

const { mainMenu } = require('../menu/menu.js');

module.exports = (bot, db) => {
  // Состояния регистрации по chat_id
  const regSteps = {};

  // /start
  bot.start(async ctx => {
    const chat_id = ctx.from.id;
    const user = (await db.query('SELECT * FROM users WHERE chat_id = $1', [chat_id])).rows[0];

    if (user) {
      await ctx.reply(
        `Привет, ${user.first_name || ctx.from.first_name || 'друг'}!\n` +
        `Вы уже зарегистрированы как владелец магазина: *${user.shop_name}*`, mainMenu()
      );
      return;
    }

    regSteps[chat_id] = { step: 1 };
    await ctx.reply('Добро пожаловать! Введите название вашего магазина на Ozon:');
  });

  // Регистрация (последовательно спрашиваем всё нужное)
  bot.on('text', async ctx => {
    const chat_id = ctx.from.id;
    const state = regSteps[chat_id];

    // Только если не команда и в процессе регистрации
    if (!state || ctx.message.text.startsWith('/')) return;

    if (state.step === 1) {
      state.shop_name = ctx.message.text.trim();
      state.step = 2;
      await ctx.reply('Введите ваш client_id:');
    } else if (state.step === 2) {
      const client_id = ctx.message.text.trim();
      // Проверка — есть ли уже такой client_id в базе
      const clientExists = (await db.query('SELECT 1 FROM users WHERE client_id = $1', [client_id])).rowCount;
      if (clientExists) {
        await ctx.reply('Такой client_id уже зарегистрирован. Попробуйте другой.');
        return;
      }
      state.client_id = client_id;
      state.step = 3;
      await ctx.reply('Введите ваш api_key:');
    } else if (state.step === 3) {
      state.seller_api = ctx.message.text.trim();
      // Записываем в базу
      await db.query(`
        INSERT INTO users (chat_id, client_id, seller_api, first_name, last_name, shop_name, is_subscribed, registered_at)
        VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
        ON CONFLICT (chat_id) DO UPDATE SET 
          client_id = EXCLUDED.client_id, 
          seller_api = EXCLUDED.seller_api,
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          shop_name = EXCLUDED.shop_name,
          is_subscribed = true
      `, [
        chat_id,
        state.client_id,
        state.seller_api,
        ctx.from.first_name || '',
        ctx.from.last_name || '',
        state.shop_name
      ]);
      await ctx.reply(
  'Вы успешно зарегистрированы!',
  mainMenu()
);

      delete regSteps[chat_id];
    }
  });
};
