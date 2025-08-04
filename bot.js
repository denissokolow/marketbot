require('dotenv').config();
const { Telegraf } = require('telegraf');
const db = require('./db');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { getMainMenu } = require('./menu/menu.js');
const { makeYesterdayReportText } = require('./reportText');
const { getYesterdayISO } = require('./utils');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Сначала подключаем все команды (кроме register.js, где есть bot.on('text'))
fs.readdirSync(path.join(__dirname, 'commands')).forEach(file => {
  if (file.endsWith('.js') && file !== 'register.js') {
    require(`./commands/${file}`)(bot, db);
  }
});
// В конце только register.js
require('./commands/register.js')(bot, db);

// --- Рассылка отчета за вчера (cron) ---
cron.schedule('0 6 * * *', async () => {
  const users = (await db.query('SELECT * FROM users WHERE is_subscribed = true')).rows;
  const date = getYesterdayISO();
  for (let user of users) {
    try {
      const report = await makeYesterdayReportText(user, date);
      await bot.telegram.sendMessage(user.chat_id, report, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error(e.message);
    }
  }
});

bot.launch().then(() => console.log("Бот успешно запущен!"));
db.connect();

