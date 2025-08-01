require('dotenv').config();
const { Client } = require('pg');
const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');

// --- Подключение к БД ---
const db = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT)
});

// --- Инициализация бота ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// --- Хранилище этапов регистрации ---
const usersAwaiting = {};

// --- Главное меню ---
function getMainMenu() {
  return Markup.keyboard([
    ['🔄 Прислать статус сейчас', '❓ Помощь'],
    ['📩 Подписаться на рассылку', '🔕 Отписаться от рассылки']
  ]).resize();
}

// --- Получение названия магазина через парсинг страницы Ozon ---
async function getSellerName(client_id) {
  const url = `https://www.ozon.ru/seller/${client_id}/`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const $ = cheerio.load(resp.data);
    const name = $('h1').first().text().trim();
    return name || 'Не удалось найти имя магазина';
  } catch (e) {
    return 'Ошибка при получении информации о магазине';
  }
}

// --- Заглушка для статуса магазина (можно заменить на реальные данные из API) ---
async function getShopStatus() {
  return "Текущий статус магазина:\n\n✅ Все работает штатно\n🕒 Часы работы: 9:00 - 21:00\n📞 Контакты: +7 (XXX) XXX-XX-XX";
}

// --- Старт/регистрация ---
bot.start(async ctx => {
  const chat_id = ctx.from.id;
  const res = await db.query('SELECT * FROM users WHERE chat_id = $1', [chat_id]);
  if (res.rowCount > 0) {
    await ctx.reply('Вы уже зарегистрированы!', getMainMenu());
  } else {
    usersAwaiting[chat_id] = { step: 'client_id' };
    await ctx.reply('Для регистрации введите ваш client_id (это же seller_id):');
  }
});

// --- Универсальный обработчик текстовых сообщений ---
bot.on('text', async ctx => {
  const chat_id = ctx.from.id;

  // === Регистрация ===
  if (usersAwaiting[chat_id]) {
    const state = usersAwaiting[chat_id];
    if (state.step === 'client_id') {
      state.client_id = ctx.message.text.trim();
      state.step = 'seller_api';
      await ctx.reply('Теперь введите ваш seller_api:');
    } else if (state.step === 'seller_api') {
      state.seller_api = ctx.message.text.trim();
      await db.query(`
        INSERT INTO users (chat_id, client_id, seller_api, is_subscribed, first_name, last_name)
        VALUES ($1, $2, $3, true, $4, $5)
        ON CONFLICT (chat_id)
        DO UPDATE SET client_id = $2, seller_api = $3, is_subscribed = true, updated_at = NOW()
      `, [
        chat_id,
        state.client_id,
        state.seller_api,
        ctx.from.first_name || '',
        ctx.from.last_name || ''
      ]);
      // Новый блок: получаем название магазина
      const sellerName = await getSellerName(state.client_id);
      await ctx.reply(`✅ Регистрация завершена!\nВаш магазин: "${sellerName}"`, getMainMenu());
      delete usersAwaiting[chat_id];
      return;
    }
    return;
  }

  // === Обработка кнопок ===
  if (ctx.message.text === '🔄 Прислать статус сейчас') {
    await ctx.reply(await getShopStatus(), getMainMenu());
  }

  if (ctx.message.text === '❓ Помощь') {
    await ctx.reply('Справка:\n\n- Зарегистрируйтесь (client_id + seller_api)\n- "Прислать статус сейчас" — мгновенный отчёт\n- "Подписаться/отписаться от рассылки" — управляет ежедневными уведомлениями', getMainMenu());
  }

  if (ctx.message.text === '📩 Подписаться на рассылку') {
    await db.query('UPDATE users SET is_subscribed = true WHERE chat_id = $1', [chat_id]);
    await ctx.reply('Вы подписались на рассылку.', getMainMenu());
  }

  if (ctx.message.text === '🔕 Отписаться от рассылки') {
    await db.query('UPDATE users SET is_subscribed = false WHERE chat_id = $1', [chat_id]);
    await ctx.reply('Вы отписались от рассылки.', getMainMenu());
  }
});

// --- Ежедневная рассылка только подписанным ---
cron.schedule('0 10 * * *', async () => {
  const { rows } = await db.query('SELECT chat_id FROM users WHERE is_subscribed = true');
  const status = await getShopStatus();
  for (let user of rows) {
    try {
      await bot.telegram.sendMessage(user.chat_id, `Ежедневный отчет:\n\n${status}`);
    } catch (e) {
      console.log('Ошибка отправки:', user.chat_id, e.message);
    }
  }
});

// --- Запуск ---
db.connect().then(() => bot.launch());
