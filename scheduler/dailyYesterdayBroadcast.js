// scheduler/dailyYesterdayBroadcast.js
const { makeYesterdayReportText, makeYesterdaySkuBreakdownText } = require('../utils/reportText');

const MIN_STEP_MS = Number(process.env.BROADCAST_MIN_STEP_MS || 6000); // не чаще одного юзера раз в 6с
const ENABLE = process.env.ENABLE_DAILY_BROADCAST !== '0';            // можно выключить .env флагом

// получить «сейчас» в Москве и его компоненты
function getMoscowNowParts() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const y = Number(map.year);
  const m = Number(map.month);
  const d = Number(map.day);
  const hh = Number(map.hour);
  const mm = Number(map.minute);
  const ymd = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { ymd, hh, mm };
}

async function fetchAllUsersWithShops(db) {
  // users + shops (берём seller api и имя магазина из shops; alias под ожидаемые поля)
  const sql = `
    SELECT 
      u.chat_id,
      COALESCE(u.is_subscribed, FALSE) AS is_subscribed,
      s.client_id,
      s.api_key       AS seller_api,
      COALESCE(s.name, s.shop_name, '') AS shop_name
    FROM users u
    JOIN shops s ON s.chat_id = u.chat_id
    WHERE s.client_id IS NOT NULL AND s.api_key IS NOT NULL
  `;
  const r = await db.query(sql);
  return r.rows || [];
}

async function fetchTrackedSkus(db, chatId) {
  const r = await db.query(`
    SELECT sp.sku::bigint AS sku
    FROM shop_products sp
    JOIN shops s ON s.id = sp.shop_id
    WHERE s.chat_id = $1 AND sp.tracked = TRUE
  `, [chatId]);
  return (r.rows || []).map(x => Number(x.sku)).filter(Number.isFinite);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendForUser(bot, db, row, index, stepMs) {
  const chatId = row.chat_id;
  try {
    const trackedSkus = await fetchTrackedSkus(db, chatId);
    const user = {
      shop_name: row.shop_name || 'Неизвестно',
      client_id: row.client_id,
      seller_api: row.seller_api,
    };

    // 1) первое сообщение (всем)
    const first = await makeYesterdayReportText(user, { db, chatId, trackedSkus });
    await bot.telegram.sendMessage(chatId, first, { parse_mode: 'HTML', disable_web_page_preview: true });

    // 2) второе сообщение (только подписчикам)
    if (row.is_subscribed) {
      const second = await makeYesterdaySkuBreakdownText(user, { db, chatId, trackedSkus });
      await bot.telegram.sendMessage(chatId, second, { parse_mode: 'HTML', disable_web_page_preview: true });
    }
  } catch (e) {
    console.error(`[broadcast] chat ${chatId} error:`, e?.response?.data || e.message);
    // мягкий фоллбек — не роняем рассылку
  } finally {
    // добавить небольшой джиттер перед следующим
    await delay(stepMs + Math.floor(Math.random() * 800));
  }
}

function initDailyYesterdayBroadcast(bot, db) {
  if (!ENABLE) {
    console.log('[broadcast] disabled via ENABLE_DAILY_BROADCAST=0');
    return;
  }

  let lastRunYmd = null;     // в какой московский день уже запускали
  let isRunning = false;     // чтобы не запустить второй раз параллельно

  // проверять раз в минуту «окно 8:00–8:59 мск»
  setInterval(async () => {
    try {
      const { ymd, hh } = getMoscowNowParts();
      if (hh !== 8) return;            // вне окна
      if (isRunning) return;           // уже идёт
      if (lastRunYmd === ymd) return;  // сегодня уже запускали

      isRunning = true;
      lastRunYmd = ymd;

      console.log(`[broadcast] start for ${ymd} MSK window 08:00–09:00`);

      // список пользователей
      const users = await fetchAllUsersWithShops(db);
      if (!users.length) {
        console.log('[broadcast] no users found');
        isRunning = false;
        return;
      }

      // перемешаем, чтобы равномерно по часу
      for (let i = users.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [users[i], users[j]] = [users[j], users[i]];
      }

      // шаг между пользователями: не чаще MIN_STEP_MS, но постараемся уместить в час
      const stepMs = Math.max(MIN_STEP_MS, Math.floor(3600_000 / users.length));
      console.log(`[broadcast] users: ${users.length}, step ≈ ${stepMs} ms`);

      // последовательная отправка, с шагом
      for (let i = 0; i < users.length; i++) {
        await sendForUser(bot, db, users[i], i, stepMs);
      }

      console.log('[broadcast] done');
      isRunning = false;
    } catch (e) {
      console.error('[broadcast] fatal:', e);
      isRunning = false;
    }
  }, 60_000); // проверка каждую минуту
}

module.exports = { initDailyYesterdayBroadcast };
