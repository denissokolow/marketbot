const cron = require('node-cron');

function startDailyYesterday({ bot, pool, logger, config }) {
  if (!config.broadcast.enabled) return;
  cron.schedule(config.broadcast.cron, async () => {
    logger.info('Daily broadcast tick (заглушка)');
    // TODO: пройти по пользователям, собрать отчёт и отправить
  }, { timezone: config.broadcast.tz });
}

module.exports = startDailyYesterday;
