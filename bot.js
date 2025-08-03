require('dotenv').config();
const { Telegraf } = require('telegraf');
const db = require('./db');
const fs = require('fs');
const path = require('path');
const { getMainMenu } = require('./menu/menu.js');
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start(async ctx => {
  registrationStep[ctx.from.id] = {};
  await ctx.reply('Для регистрации введите ваш client_id и api_key через пробел:', getMainMenu());
});

// Сначала регистрируем все команды, КРОМЕ файла с bot.on!
fs.readdirSync(path.join(__dirname, 'commands')).forEach(file => {
  if (file.endsWith('.js') && file !== 'register.js') {
    require(`./commands/${file}`)(bot, db);
  }
});

// В САМОМ КОНЦЕ — только register.js, где есть bot.on('text', ...)
require('./commands/register.js')(bot, db);

bot.launch().then(() => console.log("Бот успешно запущен!"));
db.connect();
