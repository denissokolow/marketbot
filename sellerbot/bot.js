// bot.js (в корне)
const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');

const { config } = require('./src/config');
const { logger } = require('./src/logger');
const { pool } = require('./src/pool');
const startDailyYesterday = require('./src/jobs/daily-yesterday');

const bot = new Telegraf(config.botToken);

// автоподключение команд из src/commands
const commandsDir = path.join(__dirname, 'src', 'commands');
for (const file of fs.readdirSync(commandsDir)) {
  if (!file.endsWith('.js')) continue;
  const mod = require(path.join(commandsDir, file));
  if (typeof mod.register === 'function') {
    mod.register(bot, { pool, logger, config });
    logger.info({ file }, 'command registered');
  }
}

(async () => {
  await bot.launch();
  startDailyYesterday({ bot, pool, logger, config });
  logger.info('Bot started');
})();

const stop = async (sig) => {
  logger.info({ sig }, 'Shutting down');
  try { await pool.end(); } catch {}
  bot.stop(sig);
  process.exit(0);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
