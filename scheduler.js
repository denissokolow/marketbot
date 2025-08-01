const cron = require('node-cron');
const { Pool } = require('pg');
const { Telegraf } = require('telegraf');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

const db = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT
});

cron.schedule('0 10 * * *', async () => {
  const { rows } = await db.query('SELECT chat_id FROM users WHERE subscribed = true');

  for (const user of rows) {
    await bot.telegram.sendMessage(user.chat_id, '📬 Ежедневная рассылка');
  }
});

