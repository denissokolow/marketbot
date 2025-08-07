require('dotenv').config();
const { Telegraf } = require('telegraf');
const db = require('./db');
const fs = require('fs');
const path = require('path');
const { mainMenu } = require('./menu/menu.js');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Подключаем все команды
fs.readdirSync(path.join(__dirname, 'commands')).forEach(file => {
  if (file.endsWith('.js') && file !== 'register.js') {
    require(`./commands/${file}`)(bot, db);
  }
});
// Только в самом конце!
require('./commands/register.js')(bot, db);

// /start команда с приветствием и меню
bot.start(async ctx => {
  await ctx.reply('Добро пожаловать! Используйте меню команд Telegram.', mainMenu());
});

// Запуск бота
bot.launch().then(() => console.log('Бот успешно запущен!'));
db.connect();


