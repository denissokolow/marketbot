require('dotenv').config();
const { Telegraf } = require('telegraf');
const db = require('./db');
const fs = require('fs');
const path = require('path');
const { mainMenu } = require('./menu/menu.js');
const {
  ensureRegisteredOrWelcome,
  assertSubscribedOrReply,
} = require('./utils/subscription');
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled Promise rejection:', err);
  // Лучше умереть и перезапуститься, чем зависнуть в полубитом состоянии
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  process.exit(1);
});

const bot = new Telegraf(process.env.BOT_TOKEN);

// 1) Гейт: для НЕзарегистрированных — на все команды показываем приветствие.
//    Исключения: /start и клик по кнопке "Регистрация".
bot.use(async (ctx, next) => {
  try {
    // Разрешаем клик по inline-кнопке регистрации
    if (ctx.callbackQuery?.data === 'register_begin') return next();

    const text = ctx.message?.text || '';
    const isCommand = text.startsWith('/');
    if (!isCommand) return next();

    const cmd = text.trim().split(/\s+/)[0];
    if (cmd === '/start') return next();

    const ok = await ensureRegisteredOrWelcome(ctx, db);
    if (!ok) return; // уже отправили приветствие
    return next();
  } catch (e) {
    console.error('[middleware:ensureRegisteredOrWelcome] error:', e);
    return next();
  }
});

// 2) Гейт по подписке для платных команд (срабатывает ТОЛЬКО после регистрации)
bot.use(async (ctx, next) => {
  const text = ctx.message?.text;
  if (!text) return next();
  const cmd = String(text).trim().split(/\s+/)[0];
  const gated = new Set(['/report_today', '/last30', '/mtd']);
  if (gated.has(cmd)) {
    const ok = await assertSubscribedOrReply(ctx, db);
    if (!ok) return;
  }
  return next();
});

// Подключаем все команды
fs.readdirSync(path.join(__dirname, 'commands')).forEach(file => {
  if (file.endsWith('.js') && file !== 'register.js') {
    require(`./commands/${file}`)(bot, db);
  }
});
// Только в самом конце!
require('./commands/register.js')(bot, db);

// /start команда с приветствием и меню (для зарегистрированных)
bot.start(async ctx => {
  await ctx.reply('Добро пожаловать! Используйте меню команд Telegram.', mainMenu());
});

// Запуск бота
bot.launch().then(() => console.log('Бот успешно запущен!'));
db.connect();
