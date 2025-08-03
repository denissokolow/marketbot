require('dotenv').config();
const { Telegraf } = require('telegraf');
const db = require('./db');
const fs = require('fs');
const path = require('path');
const { getYesterdayISO } = require('./utils');
const { makeYesterdayReportText } = require('./utils/reportText');

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
const cron = require('node-cron');
cron.schedule('0 10 * * *', async () => {
  const users = (await db.query('SELECT * FROM users WHERE is_subscribed = true')).rows;
  const date = getYesterdayISO();
  for (let user of users) {
    try {
      const report = await makeYesterdayReportText(user, date);
      await bot.telegram.sendMessage(user.chat_id, report, { parse_mode: 'Markdown' });
    } catch (e) {
      console.log(`Ошибка отправки для ${user.chat_id}:`, e.message);
    }
  }
});

bot.launch().then(() => console.log("Бот успешно запущен!"));
db.connect();

