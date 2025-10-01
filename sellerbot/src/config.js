require('dotenv').config();

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

const dbUrl = process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres://')
  ? process.env.DATABASE_URL
  : null;

const config = {
  botToken: process.env.BOT_TOKEN,
  timezone: process.env.TZ || 'Europe/Moscow',

  // БД: либо URL, либо по кусочкам из DB_*
  db: dbUrl ? { url: dbUrl } : {
    host: process.env.DB_HOST || process.env.DATABASE_URL || 'localhost',
    port: num(process.env.DB_PORT, 5432),
    database: process.env.DB_NAME || 'sellerboss',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  },

  broadcast: {
    enabled: process.env.BROADCAST_ENABLED !== '0',
    cron: process.env.BROADCAST_CRON || '0 7 * * *',
    tz: process.env.BROADCAST_TZ || 'Europe/Moscow',
    minStepMs: num(process.env.BROADCAST_MIN_STEP_MS, 4000),
  },

  ozon: {
    globalRps: num(process.env.OZON_GLOBAL_RPS, 8),
    concurrency: num(process.env.OZON_CONCURRENCY, 2),
    maxRetries: num(process.env.OZON_MAX_RETRIES, 5),
    backoffBaseMs: num(process.env.OZON_BACKOFF_BASE_MS, 400),
    timeoutMs: num(process.env.OZON_TIMEOUT_MS, 20000),
  },
};

if (!config.botToken) throw new Error('BOT_TOKEN is required');

module.exports = { config };
