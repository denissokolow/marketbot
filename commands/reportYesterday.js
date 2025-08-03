const { getOzonReport } = require('../services/ozonService');
const { getYesterdayISO } = require('../utils/date');

const cron = require('node-cron');

module.exports = (bot, db) => {
  // Рассылка отчёта за вчера всем подписчикам
  cron.schedule('0 10 * * *', async () => {
    const users = (await db.query('SELECT * FROM users WHERE is_subscribed = true')).rows;
    const date = getYesterdayISO();
    for (let user of users) {
      try {
        const report = await getOzonReport(user.client_id, user.seller_api, date, 'yesterday', user.shop_name);
        await bot.telegram.sendMessage(user.chat_id, report, { parse_mode: 'Markdown' });
      } catch (e) {
        console.log(`Ошибка отправки для ${user.chat_id}:`, e.message);
      }
    }
  });
};
