require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const db = require('./db');
const { getTodayReport, getYesterdayReport } = require('./ozon');

function getYesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function getMainMenu() {
  return Markup.keyboard([
    ['🔄 Прислать статус сейчас', '❓ Помощь'],
    ['📩 Подписаться на рассылку', '🔕 Отписаться от рассылки']
  ]).resize();
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const registrationStep = {};

// --- Регистрация ---
bot.start(async ctx => {
  registrationStep[ctx.from.id] = {};
  await ctx.reply('Для регистрации введите ваш client_id и api_key через пробел:');
});

// --- Приём client_id и seller_api ---
bot.hears(/^(\d+) (.+)$/i, async ctx => {
  const chat_id = ctx.from.id;
  registrationStep[chat_id] = {
    client_id: ctx.match[1],
    seller_api: ctx.match[2],
    first_name: ctx.from.first_name || '',
    last_name: ctx.from.last_name || ''
  };
  await ctx.reply('Введите название вашего магазина (как отображается на Ozon):');
});

// --- Отправка отчёта за сегодня ---
bot.hears('🔄 Прислать статус сейчас', async ctx => {
  const chat_id = ctx.from.id;
  const user = (await db.query('SELECT * FROM users WHERE chat_id=$1', [chat_id])).rows[0];
  if (!user) return ctx.reply('Сначала зарегистрируйтесь через /start');

  const today = new Date().toISOString().slice(0, 10);
  const report = await getTodayReport({ 
    client_id: user.client_id, 
    api_key: user.seller_api, 
    date: today, 
    shop_name: user.shop_name 
  });
  ctx.reply(report, { parse_mode: 'Markdown', reply_markup: getMainMenu().reply_markup });
});

// --- Подписка/отписка ---
bot.hears('📩 Подписаться на рассылку', async ctx => {
  const chat_id = ctx.from.id;
  await db.query('UPDATE users SET is_subscribed=true WHERE chat_id=$1', [chat_id]);
  ctx.reply('Вы подписались на рассылку!', getMainMenu());
});
bot.hears('🔕 Отписаться от рассылки', async ctx => {
  const chat_id = ctx.from.id;
  await db.query('UPDATE users SET is_subscribed=false WHERE chat_id=$1', [chat_id]);
  ctx.reply('Вы отписались от рассылки.', getMainMenu());
});
bot.hears('❓ Помощь', ctx => {
  ctx.reply('Для помощи обратитесь к администратору.', getMainMenu());
});

// --- Приём shop_name (только при регистрации) ---
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
      { parse_mode: 'Markdown', reply_markup: getMainMenu().reply_markup }
    );
    return;
  }
});

// --- Рассылка отчёта за вчера ---
cron.schedule('0 10 * * *', async () => {
  const users = (await db.query('SELECT * FROM users WHERE is_subscribed = true')).rows;
  const date = getYesterdayISO();

  for (let user of users) {
    try {
      const report = await getYesterdayReport({ 
        client_id: user.client_id, 
        api_key: user.seller_api, 
        date, 
        shop_name: user.shop_name 
      });
      await bot.telegram.sendMessage(user.chat_id, report, { parse_mode: 'Markdown' });
    } catch (e) {
      console.log(`Ошибка отправки для ${user.chat_id}:`, e.message);
    }
  }
});

bot.launch().then(() => console.log("Бот успешно запущен!"));
db.connect();
