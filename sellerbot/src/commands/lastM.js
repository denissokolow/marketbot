// src/commands/lastM.js
const { sendWelcomeCard } = require('../utils/replies');
const { makeLastMPerSkuText } = require('../utils/reportLastMsku');

// опциональные модули — не должны ломать регистрацию
let sendLastMCharts = null;
try {
  ({ sendLastMCharts } = require('../charts/lastM'));
} catch {
  sendLastMCharts = null;
}

let makeLastMTextAndData = null;
try {
  ({ makeLastMTextAndData } = require('../utils/reportLastMsku'));
} catch {
  makeLastMTextAndData = null;
}

// ————— утилиты —————
function parseMoneyStrToNumber(s) {
  if (!s) return null;
  const clean = String(s).replace(/[^\d\-]/g, '').replace(/(\d)-$/,'$1'); // страховка от странных хвостов
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}
function stripHtmlCodeTags(text='') {
  return text.replace(/<\/?code>/g, '');
}

// Парсер резервный: извлекаем items из уже собранного текстового отчёта /lastM
// Ожидаем блоки вида:
//   📦 Название (SKU)
//   ▫️ Заказано: X шт. на Y₽
//   ▫️ Выкуплено: A шт. на B₽
//   ... (иконки перед подсказками допускаются)
//   ▫️ Расходы: Z₽      или "нет"
//   ▫️ Прибыль: P₽      или "нет"
function parseItemsFromLastMText(fullText) {
  if (!fullText) return [];

  const t = stripHtmlCodeTags(fullText);
  // Разбиваем на блоки по «📦 ... (SKU)»
  // Секция начинается с "📦 " и до следующего " - - - - " или конца
  const lines = t.split('\n').map(s => s.trim());

  const items = [];
  let cur = null;

  const startRe = /^📦\s+(.+?)\s*\((\d{6,})\)\s*$/; // "📦 Название (2583172589)"
  const orderedRe = /^▫️?\s*Заказано:\s*([\d\s-]+)\s*шт\.\s*на\s*([\d\s-]+)₽/i;
  const buyoutRe  = /^▫️?\s*Выкуплено:\s*([\d\s-]+)\s*шт\.\s*на\s*([\d\s-]+)₽/i;
  const expensesRe= /^▫️?\s*Расходы:?\s*(?:нет|—|-\s*)$/i;
  const expensesValRe = /^▫️?\s*Расходы:?\s*([\d\s-]+)₽/i;
  const profitRe  = /Прибыль:\s*([\d\s-]+)₽/i;
  const sepRe     = /^-+\s-+\s-+\s-+$/; // " - - - - "

  for (const ln of lines) {
    if (sepRe.test(ln)) {
      if (cur) { items.push(cur); cur = null; }
      continue;
    }
    const mStart = ln.match(startRe);
    if (mStart) {
      if (cur) { items.push(cur); }
      cur = {
        title: mStart[1].trim(),
        sku: Number(mStart[2]),
        ordered_units: 0,
        revenue: 0,
        buyout_units: 0,
        buyout_revenue: 0,
        ad_spend: 0,
        profit: null,
      };
      continue;
    }
    if (!cur) continue;

    const mOrd = ln.match(orderedRe);
    if (mOrd) {
      const units = parseMoneyStrToNumber(mOrd[1]);
      const money = parseMoneyStrToNumber(mOrd[2]);
      if (units != null) cur.ordered_units = units;
      if (money != null) cur.revenue = money;
      continue;
    }
    const mBuy = ln.match(buyoutRe);
    if (mBuy) {
      const units = parseMoneyStrToNumber(mBuy[1]);
      const money = parseMoneyStrToNumber(mBuy[2]);
      if (units != null) cur.buyout_units = units;
      if (money != null) cur.buyout_revenue = money;
      continue;
    }
    if (expensesRe.test(ln)) {
      cur.ad_spend = 0;
      continue;
    }
    const mExp = ln.match(expensesValRe);
    if (mExp) {
      const money = parseMoneyStrToNumber(mExp[1]);
      if (money != null) cur.ad_spend = money;
      continue;
    }
    const mProf = ln.match(profitRe);
    if (mProf) {
      const money = parseMoneyStrToNumber(mProf[1]);
      if (money != null) cur.profit = money;
      continue;
    }
  }
  if (cur) items.push(cur);

  // Отфильтруем мусор (без SKU/названия — выкинуть)
  return items.filter(x => Number.isFinite(x.sku) && (x.title || '').length > 0);
}

// На всякий случай: вытаскиваем подпись периода из первого блока
function extractPeriodLabelFromText(text) {
  const t = stripHtmlCodeTags(text);
  const m = t.match(/Период:\s*(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})/);
  if (m) return `${m[1]} → ${m[2]}`;
  return null;
}

async function fetchTrackedSkus(pool, chatId) {
  // сначала пробуем tracked = TRUE; если поля нет — берём все
  try {
    const r = await pool.query(`
      SELECT sp.sku::bigint AS sku
        FROM shop_products sp
        JOIN shops s ON s.id = sp.shop_id
        JOIN users u ON u.id = s.user_id
       WHERE u.chat_id = $1
         AND sp.tracked = TRUE
    `, [chatId]);
    return (r.rows || []).map(x => Number(x.sku)).filter(Number.isFinite);
  } catch (e) {
    if (e?.code !== '42703') throw e;
    const r2 = await pool.query(`
      SELECT sp.sku::bigint AS sku
        FROM shop_products sp
        JOIN shops s ON s.id = sp.shop_id
        JOIN users u ON u.id = s.user_id
       WHERE u.chat_id = $1
    `, [chatId]);
    return (r2.rows || []).map(x => Number(x.sku)).filter(Number.isFinite);
  }
}

function register(bot, { pool, logger }) {
  bot.command(['lastm', 'lastM'], async (ctx) => {
    const chatId = ctx.from?.id;
    logger?.info?.({ chatId }, '/lastM invoked');

    try {
      // есть пользователь?
      const u = await pool.query('SELECT id FROM users WHERE chat_id=$1 LIMIT 1', [chatId]);
      if (!u.rowCount) { await sendWelcomeCard(ctx); return; }

      // магазин + Ozon-креды
      const s = await pool.query(
        `SELECT s.name, s.ozon_client_id, s.ozon_api_key
           FROM shops s
           JOIN users u ON u.id = s.user_id
          WHERE u.chat_id = $1
          ORDER BY s.created_at DESC NULLS LAST, s.id DESC
          LIMIT 1`,
        [chatId]
      );
      if (!s.rowCount || !s.rows[0].ozon_client_id || !s.rows[0].ozon_api_key) {
        await ctx.reply('⚠️ Заполните Client-Id и Api-Key Ozon в магазине.');
        return;
      }

      const user = {
        client_id:  s.rows[0].ozon_client_id,
        seller_api: s.rows[0].ozon_api_key,
        shop_name:  s.rows[0].name || '',
      };

      const trackedSkus = await fetchTrackedSkus(pool, chatId);
      if (!trackedSkus.length) {
        await ctx.reply('⚠️ Нет отслеживаемых товаров для отчёта.');
        return;
      }

      // --- текстовое сообщение (всегда) ---
      let text, items = null, periodLabel = null;

      if (typeof makeLastMTextAndData === 'function') {
        if (process.env.DEBUG_LASTM === '1') console.log('[lastM] using makeLastMTextAndData');
        const res = await makeLastMTextAndData(user, { trackedSkus, db: pool, chatId });
        text = res?.text || '';
        items = Array.isArray(res?.items) ? res.items : null;
        periodLabel = res?.periodLabel || null;
      } else {
        if (process.env.DEBUG_LASTM === '1') console.log('[lastM] using makeLastMPerSkuText');
        text = await makeLastMPerSkuText(user, { trackedSkus, db: pool, chatId });
      }

      await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true });

      // --- графики (второе сообщение) ---
      const chartsEnabled = process.env.ENABLE_LASTM_CHARTS !== '0';
      if (!chartsEnabled) {
        if (process.env.DEBUG_LASTM === '1') console.log('[lastM] charts disabled via ENV');
        return;
      }
      if (!sendLastMCharts) {
        if (process.env.DEBUG_LASTM === '1') console.log('[lastM] charts sender not present (src/charts/lastM.js missing?)');
        return;
      }

      // если items не пришли из utils — парсим из текста
      if (!items || !items.length) {
        items = parseItemsFromLastMText(text);
        if (process.env.DEBUG_LASTM === '1') {
          console.log('[lastM] items parsed from text:', items.slice(0, 3));
        }
      }

      if (!periodLabel) {
        periodLabel = extractPeriodLabelFromText(text);
      }
      if (!periodLabel) {
        // резервная подпись "прошлый месяц"
        const now = new Date();
        const y = now.getUTCFullYear();
        const m = now.getUTCMonth();
        const first = new Date(Date.UTC(y, m - 1, 1));
        const last  = new Date(Date.UTC(y, m, 0));
        const iso = (d) => {
          const yy = d.getUTCFullYear();
          const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
          const dd = String(d.getUTCDate()).padStart(2, '0');
          return `${yy}-${mm}-${dd}`;
        };
        periodLabel = `${iso(first)} → ${iso(last)}`;
      }

      if (items && items.length) {
        try {
          await sendLastMCharts({ bot: ctx.telegram, chatId, items, period: periodLabel });
        } catch (e) {
          logger?.warn?.(e, '[lastM] charts send failed');
        }
      } else if (process.env.DEBUG_LASTM === '1') {
        console.log('[lastM] charts skipped (no items after parse)');
      }
    } catch (e) {
      logger?.error?.(e, '/lastM error');
      await ctx.reply('⚠️ Не удалось сформировать отчёт за прошлый месяц.');
    }
  });
}

module.exports = register;
module.exports.register = register;
