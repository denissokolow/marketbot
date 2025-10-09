// src/jobs/daily-yesterday.js
// Утренняя рассылка /yesterday (07:00 Europe/Moscow) с диагностикой логов

const cron = require('node-cron');
const { makeYesterdaySummaryText } = require('../utils/reportTextYest');
const { makeYesterdayPerSkuText }  = require('../utils/reportYestSku');

console.log('[broadcast] daily-yesterday.js loaded');

let _scheduled = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendWithRetry(bot, chatId, text, opts, retries = 3, baseDelayMs = 1200, logger) {
  let attempt = 0;
  while (true) {
    try {
      await bot.telegram.sendMessage(
        chatId,
        text,
        { parse_mode: 'HTML', disable_web_page_preview: true, ...(opts || {}) }
      );
      return true;
    } catch (e) {
      attempt += 1;
      const code = e?.response?.error_code ?? e?.code ?? 'ERR';
      logger?.warn?.({ chatId, code, attempt, msg: e?.message }, '[broadcast] send fail');
      if (attempt >= retries) return false;
      const pause = baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 400);
      await sleep(pause);
    }
  }
}

async function hasTrackedColumn(pool) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='shop_products' AND column_name='tracked' LIMIT 1`
  );
  return r.rowCount > 0;
}

async function getTrackedSkus(pool, chatId) {
  const tracked = await hasTrackedColumn(pool);
  const sql = tracked
    ? `
      SELECT sp.sku::bigint AS sku
        FROM shop_products sp
        JOIN shops s ON s.id = sp.shop_id
        JOIN users u ON u.id = s.user_id
       WHERE u.chat_id = $1 AND sp.tracked = TRUE
      `
    : `
      SELECT sp.sku::bigint AS sku
        FROM shop_products sp
        JOIN shops s ON s.id = sp.shop_id
        JOIN users u ON u.id = s.user_id
       WHERE u.chat_id = $1
      `;
  const r = await pool.query(sql, [chatId]);
  return (r.rows || []).map(x => Number(x.sku)).filter(Number.isFinite);
}

// выборка получателей
async function fetchTargets(pool) {
  const r = await pool.query(`
    SELECT
      u.id               AS user_id,
      u.chat_id,
      u.subscription_until,
      u.is_subscribed,
      COALESCE(s.name, '')        AS shop_name,
      s.ozon_client_id,
      s.ozon_api_key
    FROM users u
    JOIN shops s ON s.user_id = u.id
    WHERE s.ozon_client_id IS NOT NULL
      AND s.ozon_api_key   IS NOT NULL
    ORDER BY s.created_at DESC NULLS LAST, s.id DESC
  `);
  return r.rows || [];
}

function isSubscriptionActive(row, now) {
  const until = row.subscription_until ? new Date(row.subscription_until) : null;
  if (until && until.getTime() >= now.getTime()) return true;
  if (process.env.USE_IS_SUBSCRIBED_FALLBACK === '1' && row.is_subscribed === true) return true;
  return false;
}

async function processOne({ bot, pool, logger }, row, stepMs) {
  const chatId = row.chat_id;
  const now = new Date();

  try {
    const trackedSkus = await getTrackedSkus(pool, chatId);
    const user = {
      client_id:  row.ozon_client_id,
      seller_api: row.ozon_api_key,
      shop_name:  row.shop_name || '',
    };

    const summary = await makeYesterdaySummaryText(user, { db: pool, chatId });
    await sendWithRetry(bot, chatId, summary, null, 3, 1200, logger);

    if (isSubscriptionActive(row, now)) {
      const perSku = await makeYesterdayPerSkuText(user, { db: pool, chatId, trackedSkus });
      await sendWithRetry(bot, chatId, perSku, null, 3, 1200, logger);
    }
  } catch (e) {
    logger?.error?.(e, `[broadcast] chat ${chatId} error`);
  } finally {
    await sleep(stepMs + Math.floor(Math.random() * 400));
  }
}

module.exports = function startDailyYesterday({ bot, pool, logger }) {
  console.log('[broadcast] startDailyYesterday invoked');

  if (_scheduled) {
    logger?.info?.('[broadcast] already scheduled, skip');
    return;
  }
  _scheduled = true;

  const expr    = process.env.YESTERDAY_CRON || '0 7 * * *';
  const tz      = process.env.YESTERDAY_TZ   || 'Europe/Moscow';
  const minStep = Math.max(Number(process.env.YESTERDAY_STEP_MS || 4000), 1000);
  const enabled = process.env.ENABLE_YESTERDAY_BROADCAST !== '0';

  logger?.info?.({ enabled, expr, tz, minStep }, '[broadcast] init config');

  if (!enabled) {
    logger?.info?.('[broadcast] /yesterday disabled via ENABLE_YESTERDAY_BROADCAST=0');
    return;
  }

  // функция одного полного запуска (используем и в cron, и для теста)
  const runOnce = async () => {
    // advisory-lock на день
    const keyText   = 'yesterday_broadcast_' + new Date().toISOString().slice(0, 10);
    const lockSql   = `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`;
    const unlockSql = `SELECT pg_advisory_unlock(hashtext($1))`;

    let locked = false;
    try {
      const r = await pool.query(lockSql, [keyText]);
      locked = r.rows?.[0]?.ok === true;
      if (!locked) {
        logger?.info?.('[broadcast] another instance holds the lock, skip');
        return;
      }

      logger?.info?.('[broadcast] starting /yesterday');

      const targets = await fetchTargets(pool);
      if (!targets.length) {
        logger?.info?.('[broadcast] no targets');
        return;
      }

      // перемешаем
      for (let i = targets.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [targets[i], targets[j]] = [targets[j], targets[i]];
      }

      const step = Math.max(minStep, Math.floor(3600_000 / targets.length));
      logger?.info?.({ users: targets.length, step }, '[broadcast] dispatch plan');

      for (const row of targets) {
        await processOne({ bot, pool, logger }, row, step);
      }

      logger?.info?.('[broadcast] done');
    } catch (e) {
      logger?.error?.(e, '[broadcast] fatal');
    } finally {
      if (locked) {
        try { await pool.query(unlockSql, [keyText]); } catch {}
      }
    }
  };

  // сам cron
  cron.schedule(expr, () => {
    logger?.info?.('[broadcast] cron tick');
    runOnce();
  }, { timezone: tz });

  logger?.info?.(`[broadcast] scheduled "${expr}" tz=${tz}, minStep=${minStep}ms`);

  // ТЕСТОВЫЙ немедленный запуск: YESTERDAY_CRON_TEST=NOW
  if ((process.env.YESTERDAY_CRON_TEST || '').toUpperCase() === 'NOW') {
    logger?.info?.('[broadcast] YESTERDAY_CRON_TEST=NOW → runOnce() in 2s');
    setTimeout(runOnce, 2000);
  }
};
