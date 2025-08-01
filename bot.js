require('dotenv').config();
const { Client } = require('pg');
const { Telegraf, session, Markup } = require('telegraf');
const cron = require('node-cron');

// ==============================================
// НАСТРОЙКА И ПРОВЕРКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ
// ==============================================
const requiredEnvVars = ['BOT_TOKEN', 'DB_USER', 'DB_HOST', 'DB_NAME', 'DB_PASSWORD', 'DB_PORT'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ Отсутствуют обязательные переменные окружения:', missingVars.join(', '));
  process.exit(1);
}

// ==============================================
// ИНИЦИАЛИЗАЦИЯ БОТА И БАЗЫ ДАННЫХ
// ==============================================
const bot = new Telegraf(process.env.BOT_TOKEN);
const client = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT),
});

// ==============================================
// НАСТРОЙКА СЕССИЙ И МЕНЮ
// ==============================================
bot.use(session({
  defaultSession: () => ({
    waitingFor: null,
    userData: {}
  })
}));

function getMainMenu() {
  return Markup.keyboard([
    ['📩 Подписаться на рассылку', '🔕 Отписаться от рассылки'],
    ['🔄 Прислать статус сейчас', '❓ Помощь']
  ]).resize().oneTime();
}

// ==============================================
// ФУНКЦИИ ДЛЯ РАБОТЫ СО СТАТУСОМ МАГАЗИНА
// ==============================================
async function getShopStatus() {
  // Заглушка - в будущем заменить на реальный API-запрос
  return `Текущий статус магазина:\n\n` +
         `✅ Все системы работают нормально\n` +
         `🕒 Часы работы: 09:00 - 21:00\n` +
         `📞 Контакты: +7 (XXX) XXX-XX-XX\n\n` +
         `Последнее обновление: ${new Date().toLocaleString()}`;
}



// ==============================================
// ОСНОВНЫЕ КОМАНДЫ БОТА
// ==============================================

// Команда /start
bot.start(async (ctx) => {
  try {
    const { id: chat_id, first_name } = ctx.from;
    
    // Проверяем есть ли пользователь в базе
    const userExists = await client.query(
      'SELECT is_subscribed FROM users WHERE chat_id = $1', 
      [chat_id]
    );

    if (userExists.rowCount === 0) {
      await client.query(
        `INSERT INTO users (chat_id, first_name, is_subscribed, client_id, seller_api) 
         VALUES ($1, $2, false, '', '')`,
        [chat_id, first_name]
      );
    }

    await ctx.replyWithMarkdown(
      `👋 Привет, *${first_name || 'друг'}*!\n\n` +
      'Я бот для отслеживания статуса магазина. Выбери действие:',
      getMainMenu()
    );
  } catch (err) {
    console.error('Ошибка в /start:', err);
    ctx.reply('⚠ Произошла ошибка. Попробуйте позже.');
  }
});

// Подписаться на рассылку
bot.hears(['📩 Подписаться на рассылку', '/subscribe'], async (ctx) => {
  try {
    const { id: chat_id } = ctx.from;
    
    await client.query(
      'UPDATE users SET is_subscribed = true WHERE chat_id = $1',
      [chat_id]
    );
    
    await ctx.reply(
      '✅ Вы успешно подписались на ежедневную рассылку!\n' +
      'Теперь вы будете получать статус магазина каждый день в 10:00 утра.',
      getMainMenu()
    );
  } catch (err) {
    console.error('Ошибка подписки:', err);
    ctx.reply('⚠ Не удалось оформить подписку.');
  }
});

// Отписаться от рассылки
bot.hears(['🔕 Отписаться от рассылки', '/unsubscribe'], async (ctx) => {
  try {
    const { id: chat_id } = ctx.from;
    
    await client.query(
      'UPDATE users SET is_subscribed = false WHERE chat_id = $1',
      [chat_id]
    );
    
    await ctx.reply(
      '🔕 Вы отписались от рассылки.\n' +
      'Вы больше не будете получать ежедневные уведомления.',
      getMainMenu()
    );
  } catch (err) {
    console.error('Ошибка отписки:', err);
    ctx.reply('⚠ Не удалось отписаться.');
  }
});

// Получить статус сейчас
bot.hears(['🔄 Прислать статус сейчас', '/status_now'], async (ctx) => {
  try {
    const status = await getShopStatus();
    await ctx.reply(status, getMainMenu());
  } catch (err) {
    console.error('Ошибка получения статуса:', err);
    ctx.reply('⚠ Не удалось получить статус магазина', getMainMenu());
  }
});

// Помощь
bot.hears(['❓ Помощь', '/help'], (ctx) => {
  ctx.replyWithMarkdown(
    '*Доступные команды:*\n\n' +
    '📩 *Подписаться на рассылку* - ежедневный статус в 10:00\n' +
    '🔕 *Отписаться от рассылки* - отменить подписку\n' +
    '🔄 *Прислать статус сейчас* - текущее состояние магазина\n\n' +
    '*Другие команды:*\n' +
    '/start - перезапустить бота\n' +
    '/help - показать это сообщение'
  );
});

// ==============================================
// ЕЖЕДНЕВНАЯ РАССЫЛКА В 10:00
// ==============================================
function setupDailyNotifications() {
  cron.schedule('0 10 * * *', async () => {
    console.log('⏰ Запуск ежедневной рассылки статуса...');
    try {
      const subscribedUsers = await client.query(
        'SELECT chat_id FROM users WHERE is_subscribed = true'
      );
      
      const status = await getShopStatus();
      const message = `🌅 Доброе утро! Вот ежедневное обновление:\n\n${status}`;
      
      for (const user of subscribedUsers.rows) {
        try {
          await bot.telegram.sendMessage(user.chat_id, message);
          console.log(`✓ Отправлено пользователю ${user.chat_id}`);
        } catch (err) {
          console.error(`✗ Ошибка отправки для ${user.chat_id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Ошибка в ежедневной рассылке:', err);
    }
  }, {
    timezone: "Europe/Moscow"
  });
}

// ==============================================
// ЗАПУСК СИСТЕМЫ И ОБРАБОТКА ОШИБОК
// ==============================================

// Обработка ошибок бота
bot.catch((err, ctx) => {
  console.error('Ошибка бота:', err);
  ctx.reply('⚠ Произошла непредвиденная ошибка.');
});

// Graceful shutdown
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

async function shutdown(signal) {
  try {
    await client.end();
    await bot.stop(signal);
    console.log('🛑 Бот остановлен');
    process.exit(0);
  } catch (err) {
    console.error('Ошибка при остановке:', err);
    process.exit(1);
  }
}

// Подключение к БД и запуск бота
client.connect()
  .then(() => {
    console.log('✅ Подключено к PostgreSQL');
    setupDailyNotifications();
    return bot.launch();
  })
  .then(() => console.log('🤖 Бот запущен и готов к работе'))
  .catch(err => {
    console.error('Ошибка запуска:', err);
    process.exit(1);
  });