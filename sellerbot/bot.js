// bot.js (в корне)
const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');

const { config } = require('./src/config');
const { logger } = require('./src/logger');
const { pool } = require('./src/pool');
const startDailyYesterday = require('./src/jobs/daily-yesterday');
const subscriptionGate = require('./src/middleware/subscription-gate');

if (!config.botToken) {
  console.error('[FATAL] BOT_TOKEN is missing');
  process.exit(1);
}

const bot = new Telegraf(config.botToken);

// ---------- paywall до команд ----------
bot.use(
  subscriptionGate({
    pool,
    logger,
  })
);

// ---------- автоподключение команд ----------
const commandsDir = path.join(__dirname, 'src', 'commands');
for (const file of fs.readdirSync(commandsDir)) {
  if (!file.endsWith('.js')) continue;
  const mod = require(path.join(commandsDir, file));
  if (typeof mod.register === 'function') {
    mod.register(bot, { pool, logger, config });
    logger.info({ file }, 'command registered');
  }
}

// ---------- ВАЖНО: запускаем планировщик ДО bot.launch() ----------
try {
  console.log('[broadcast] startDailyYesterday invoked');
  startDailyYesterday({ bot, pool, logger, config });
} catch (e) {
  logger.error(e, '[broadcast] startDailyYesterday init error');
}

// ---------- запускаем бота ----------
(async () => {
  try {
    logger.info('[bot] launching...');
    await bot.launch({ dropPendingUpdates: true });
    logger.info('[bot] bot.launch resolved');
  } catch (e) {
    logger.error(e, '[bot] launch error');
    // не выходим — cron уже запланирован и сможет попытаться слать сообщения
  }
  logger.info('Bot started');
})();

// ---------- graceful shutdown ----------
const stop = async (sig) => {
  logger.info({ sig }, 'Shutting down');
  try { await pool.end(); } catch (e) { logger.warn(e, '[bot] pool.end error'); }
  try { await bot.stop(sig); } catch (e) { logger.warn(e, '[bot] bot.stop error'); }
  process.exit(0);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

process.on('unhandledRejection', (err) => {
  logger.error(err, '[FATAL] Unhandled Promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.error(err, '[FATAL] Uncaught Exception');
  process.exit(1);
});
