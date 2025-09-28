// commands/register.js
const { Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const { mainMenu } = require('../menu/menu.js');
const { fetchStocksPositiveBySku } = require('../ozon');
const { ozonApiRequest } = require('../services/ozon/api');

const regSteps = Object.create(null);

// ---------- helpers ----------
const trim = (s) => String(s || '').trim();
const esc  = (s = '') => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// Единая HTML-ответка в <code>
function replyCode(ctx, text, extra = {}) {
  return ctx.reply(`<code>${esc(String(text))}</code>`, { parse_mode: 'HTML', ...extra });
}

// Преобразуем env-строку в корректный инпут для sendPhoto (file_id / URL / локальный путь)
function photoInputFromEnv(val) {
  if (!val) return null;
  if (/^https?:\/\//i.test(val) || val.startsWith('attach://')) return val; // URL/attach
  if (/^[\w-]{20,}$/.test(val)) return val;                                  // Telegram file_id
  const p = path.resolve(val);                                               // локальный файл
  if (fs.existsSync(p)) return { source: fs.createReadStream(p) };
  return null;
}

// Фото с подписью в <code>
async function replyPhotoCode(ctx, photoEnvValue, caption) {
  const input = photoInputFromEnv(photoEnvValue);
  if (!input) return;
  return ctx.replyWithPhoto(input, {
    caption: `<code>${esc(String(caption || ''))}</code>`,
    parse_mode: 'HTML',
  });
}

// Вчерашняя дата в YYYY-MM-DD (UTC)
function getYesterdayISO() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------- лимиты/валидация полей ----------
const MIN_SHOP_NAME_LEN = 2;
const MAX_SHOP_NAME_LEN = Number(process.env.SHOP_NAME_MAX_LEN || 80);

const CLIENT_ID_MAX_LEN      = Number(process.env.CLIENT_ID_MAX_LEN || 16);
const API_KEY_MAX_LEN        = Number(process.env.API_KEY_MAX_LEN || 128);
const PERF_CLIENT_ID_MAX_LEN = Number(process.env.PERF_CLIENT_ID_MAX_LEN || 128); // было 64 → смягчили
const PERF_SECRET_MAX_LEN    = Number(process.env.PERF_SECRET_MAX_LEN || 256);
const PERF_SECRET_MIN_LEN    = Number(process.env.PERF_SECRET_MIN_LEN || 16);

// Шаг 1: название магазина
function sanitizeShopName(raw) {
  let s = String(raw ?? '');
  s = s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  s = s.normalize('NFC');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > MAX_SHOP_NAME_LEN) s = s.slice(0, MAX_SHOP_NAME_LEN);
  return s;
}
function validateShopName(s) {
  if (!s) return { ok: false, err: 'Название не должно быть пустым. Введите название магазина:' };
  if (s.length < MIN_SHOP_NAME_LEN) return { ok: false, err: `Слишком короткое название (минимум ${MIN_SHOP_NAME_LEN} символа).` };
  if (s.length > MAX_SHOP_NAME_LEN) return { ok: false, err: `Слишком длинное название (максимум ${MAX_SHOP_NAME_LEN} символов). Сократите, пожалуйста.` };
  if (!/[0-9A-Za-zА-Яа-яЁё]/.test(s)) return { ok: false, err: 'Название должно содержать буквы или цифры.' };
  if (/[\u202E\u202A-\u202C\u2066-\u2069]/.test(s)) return { ok: false, err: 'Название содержит скрытые управляющие символы. Введите простое название.' };
  return { ok: true };
}

// Шаг 2: client_id
function sanitizeClientId(raw) {
  return String(raw ?? '').replace(/\s+/g, '').trim();
}
function validateClientId(s) {
  if (!s) return { ok: false, err: 'client_id не должен быть пустым. Введите client_id:' };
  if (!/^\d+$/.test(s)) return { ok: false, err: 'client_id должен состоять только из цифр.' };
  if (s.length > CLIENT_ID_MAX_LEN) return { ok: false, err: `Слишком длинный client_id (максимум ${CLIENT_ID_MAX_LEN} цифр).` };
  return { ok: true };
}

// Шаг 3: api_key
function sanitizeApiKey(raw) {
  return String(raw ?? '').trim();
}
function validateApiKey(s) {
  if (!s) return { ok: false, err: 'api_key не должен быть пустым. Введите api_key:' };
  if (s.length > API_KEY_MAX_LEN) return { ok: false, err: `Слишком длинный api_key (максимум ${API_KEY_MAX_LEN} символов).` };
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidLike.test(s)) return { ok: false, err: 'api_key должен быть в формате UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.' };
  return { ok: true };
}

// Шаг 4: performance_client_id (смягчено — допускаем email-вид)
function sanitizePerfClientId(raw) {
  return String(raw ?? '').trim();
}
function validatePerfClientId(s) {
  if (!s) return { ok: false, err: 'performance_client_id не должен быть пустым. Введите performance_client_id:' };
  if (s.length > PERF_CLIENT_ID_MAX_LEN) return { ok: false, err: `Слишком длинный performance_client_id (максимум ${PERF_CLIENT_ID_MAX_LEN} символов).` };
  // Разрешаем простой ID или формат вида local@domain.tld
  const simple = /^[A-Za-z0-9._-]+$/;
  const emaily = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  if (!simple.test(s) && !emaily.test(s)) {
    return { ok: false, err: 'Допустимы латиница/цифры/._- или формат вида name@domain.tld.' };
  }
  return { ok: true };
}

// Шаг 5: performance_secret
function sanitizePerfSecret(raw) {
  return String(raw ?? '').trim();
}
function validatePerfSecret(s) {
  if (!s) return { ok: false, err: 'secret_key не должен быть пустым. Введите корректный secret_key:' };
  if (s.length < PERF_SECRET_MIN_LEN) return { ok: false, err: `Слишком короткий secret_key (минимум ${PERF_SECRET_MIN_LEN} символов).` };
  if (s.length > PERF_SECRET_MAX_LEN) return { ok: false, err: `Слишком длинный secret_key (максимум ${PERF_SECRET_MAX_LEN} символов).` };
  if (!/^[A-Za-z0-9._\-=]+$/.test(s)) return { ok: false, err: 'secret_key может содержать только латиницу, цифры и символы . _ - =' };
  return { ok: true };
}

// ---------- онлайн-проверки ключей ----------
const SELLER_VERIFY_TIMEOUT_MS = Number(process.env.SELLER_VERIFY_TIMEOUT_MS || 8000);
async function verifySellerCredentials(client_id, api_key) {
  const y = getYesterdayISO();
  try {
    await ozonApiRequest({
      client_id,
      api_key,
      endpoint: '/v1/analytics/data',
      body: {
        date_from: y,
        date_to:   y,
        metrics:   ['revenue'],
        dimension: ['sku'],
        limit: 1,
        offset: 0,
      },
      timeout: SELLER_VERIFY_TIMEOUT_MS,
    });
    return true;
  } catch (e) {
    const status  = e?.response?.status;
    const message = e?.response?.data?.message || e?.message || '';
    if (status === 401 || status === 403 || /invalid/i.test(message)) return false;
    if (status === 404 && /invalid/i.test(message)) return false;
    return false;
  }
}

const PERF_VERIFY_TIMEOUT_MS = Number(process.env.PERF_VERIFY_TIMEOUT_MS || 8000);
async function verifyPerformanceCredentials(perf_client_id, perf_secret) {
  try {
    const resp = await axios.post(
      'https://api-performance.ozon.ru/api/client/token',
      { client_id: perf_client_id, client_secret: perf_secret, grant_type: 'client_credentials' },
      { timeout: PERF_VERIFY_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } }
    );
    const token = resp?.data?.access_token || resp?.data?.token || null;
    return Boolean(token);
  } catch (e) {
    const msg = e?.response?.data?.message || e?.message || '';
    if (/invalid|unauthorized|forbidden/i.test(msg)) return false;
    return false;
  }
}

// ---------- картинки-подсказки (задавайте в .env строкой пути/URL/file_id) ----------
const PHOTO_CLIENT_ID_TIP      = process.env.PHOTO_CLIENT_ID_TIP || null;        // к шагу 2
const PHOTO_API_KEY_TIP        = process.env.PHOTO_API_KEY_TIP || null;          // к шагу 3
const PHOTO_PERF_CLIENT_ID_TIP = process.env.PHOTO_PERF_CLIENT_ID_TIP || null;   // к шагу 4
const PHOTO_PERF_SECRET_TIP    = process.env.PHOTO_PERF_SECRET_TIP || null;      // к шагу 5

// Показываем соответствующую подсказку для шага (всегда вызываем при входе/возврате на шаг)
async function showStepTip(ctx, step) {
  try {
    if (step === 2) {
      await replyPhotoCode(ctx, PHOTO_CLIENT_ID_TIP, 'Подсказка: где найти client_id — Личный кабинет Ozon → Настройки → API-доступ.');
    } else if (step === 3) {
      await replyPhotoCode(ctx, PHOTO_API_KEY_TIP, 'Подсказка: где найти api_key — Личный кабинет Ozon → Настройки → API-доступ.');
    } else if (step === 4) {
      await replyPhotoCode(ctx, PHOTO_PERF_CLIENT_ID_TIP, 'Подсказка: Performance client_id — Ozon Performance → Настройки → API-доступ.');
    } else if (step === 5) {
      await replyPhotoCode(ctx, PHOTO_PERF_SECRET_TIP, 'Подсказка: Performance secret_key — Ozon Performance → Настройки → API-доступ.');
    }
  } catch (e) {
    console.warn(`[register] tip image for step ${step} failed:`, e?.message || e);
  }
}

// ---------- тексты ----------
function returningText(user, from) {
  const first = (user?.first_name || from?.first_name || '').trim();
  const last  = (user?.last_name  || from?.last_name  || '').trim();
  const name  = [first, last].filter(Boolean).join(' ').trim() || 'друг';
  return `С возвращением, ${name}!
Воспользуйтесь кнопкой «Меню» (внизу слева) с командами для взаимодействия с ботом.`;
}

function welcomeTextNewUser() {
  return `Добро пожаловать в Озон Селлер Курьер! 👋

Наш бот помогает получать данные из кабинета Ozon в удобном виде,
присылает ежедневную сводку о магазине и товарах, а также аналитику
по каждой позиции и сводную по разным периодам. Проводит ABC-анализ 
товаров и показывает проблемные места.

Вы можете ознакомиться с функционалом и тарифами:

🎞️ Видео https://telegra.ph/123-09-24-73

📰 Текст и изображения https://telegra.ph/123-09-24-73

Или сразу перейдите к регистрации, нажав кнопку «Регистрация» под сообщением. 👇`;
}

async function sendWelcomeCard(ctx) {
  return replyCode(ctx, welcomeTextNewUser(), {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('Регистрация', 'register_begin')],
    ]).reply_markup,
  });
}

// ---------- модуль ----------
module.exports = (bot, db) => {
  // /start — приветствие/старт регистрации
  bot.start(async (ctx) => {
    const chat_id = ctx.from.id;

    try {
      const uRes = await db.query('SELECT * FROM users WHERE chat_id = $1 LIMIT 1', [chat_id]);
      const user = uRes.rows[0];

      if (user) {
        await replyCode(ctx, returningText(user, ctx.from), mainMenu());
        return;
      }

      await sendWelcomeCard(ctx);
    } catch (e) {
      console.error('[register.start] error:', e);
      await replyCode(ctx, '⚠️ Произошла ошибка. Попробуйте ещё раз позже.');
    }
  });

  // Гейт: незарегистрированным на любые КОМАНДЫ показываем только приветствие/кнопку
  bot.on('text', async (ctx, next) => {
    const text = ctx.message?.text || '';
    const chat_id = ctx.from.id;

    if (!text.startsWith('/')) return next();                    // не команда — дальше
    if (regSteps[chat_id]) return next();                        // в процессе регистрации — дальше
    if (text.trim().split(/\s+/)[0] === '/start') return next(); // /start — выше

    try {
      const uRes = await db.query('SELECT 1 FROM users WHERE chat_id = $1 LIMIT 1', [chat_id]);
      const registered = !!uRes.rowCount;
      if (!registered) {
        await sendWelcomeCard(ctx);
        return;
      }
    } catch (e) {
      console.error('[register.command gate] DB check error:', e);
      await sendWelcomeCard(ctx);
      return;
    }

    return next();
  });

  // Нажатие на кнопку "Регистрация" — запускаем шаг 1
  bot.action('register_begin', async (ctx) => {
    try {
      await ctx.answerCbQuery();

      const chat_id = ctx.from.id;

      // уже зарегистрирован?
      const uRes = await db.query('SELECT 1 FROM users WHERE chat_id = $1 LIMIT 1', [chat_id]);
      if (uRes.rowCount) {
        await replyCode(ctx, 'Вы уже зарегистрированы. Откройте кнопку «Меню» для работы с ботом.', mainMenu());
        return;
      }

      regSteps[chat_id] = { step: 1 };
      await replyCode(ctx, 'Введите название вашего магазина на Ozon:');
    } catch (e) {
      console.error('[register.action register_begin] error:', e);
      await replyCode(ctx, '⚠️ Не удалось начать регистрацию. Попробуйте ещё раз командой /start.');
    }
  });

  // Пошаговая регистрация
  bot.on('text', async (ctx) => {
    const chat_id = ctx.from.id;
    const state = regSteps[chat_id];

    // не в процессе регистрации — выходим
    if (!state || ctx.message.text.startsWith('/')) return;

    try {
      // 1) Название магазина
      if (state.step === 1) {
        const sanitized = sanitizeShopName(ctx.message.text);
        const v = validateShopName(sanitized);
        if (!v.ok) return replyCode(ctx, `⚠️ ${v.err}`);

        state.shop_name = sanitized;
        state.step = 2;

        await showStepTip(ctx, 2);
        return replyCode(ctx, 'Введите ваш client_id для Seller API:');
      }

      // 2) client_id (уникален в users и shops)
      if (state.step === 2) {
        const client_id_raw = sanitizeClientId(ctx.message.text);
        const v = validateClientId(client_id_raw);
        if (!v.ok) {
          await showStepTip(ctx, 2);
          return replyCode(ctx, `⚠️ ${v.err}`);
        }

        const existsUser = await db.query('SELECT 1 FROM users WHERE client_id = $1 LIMIT 1', [client_id_raw]);
        if (existsUser.rowCount) {
          await showStepTip(ctx, 2);
          return replyCode(ctx, '⚠️ Отказ: такой client_id уже есть в базе пользователей. Укажите другой client_id.');
        }

        const existsShopClient = await db.query('SELECT 1 FROM shops WHERE client_id = $1 LIMIT 1', [client_id_raw]);
        if (existsShopClient.rowCount) {
          await showStepTip(ctx, 2);
          return replyCode(ctx, '⚠️ Отказ: такой client_id уже привязан к магазину. Укажите другой client_id.');
        }

        state.client_id = client_id_raw;
        state.step = 3;

        await showStepTip(ctx, 3);
        return replyCode(ctx, 'Введите ваш api_key для Seller API:');
      }

      // 3) api_key + онлайн-проверка пары seller
      if (state.step === 3) {
        const api_key_raw = sanitizeApiKey(ctx.message.text);
        const v = validateApiKey(api_key_raw);
        if (!v.ok) {
          await showStepTip(ctx, 3);
          return replyCode(ctx, `⚠️ ${v.err}`);
        }

        // онлайн-валидация пары client_id + api_key
        const ok = await verifySellerCredentials(state.client_id, api_key_raw);
        if (!ok) {
          // Возвращаем НА ШАГ 2: просим заново client_id (и далее api_key)
          state.step = 2;
          state.client_id = undefined;
          state.seller_api = undefined;

          await replyCode(ctx, '⚠️ Не удалось авторизоваться в Seller API. Проверьте корректность client_id и api_key.');
          await showStepTip(ctx, 2);
          return replyCode(ctx, 'Введите ваш client_id для Seller API:');
        }

        state.seller_api = api_key_raw;
        state.step = 4;

        await showStepTip(ctx, 4);
        return replyCode(ctx, 'Введите ваш performance_client_id для Performance API:');
      }

      // 4) performance_client_id (уникален в shops) — валидация смягчена
      if (state.step === 4) {
        const perf_client_id_raw = sanitizePerfClientId(ctx.message.text);
        const v = validatePerfClientId(perf_client_id_raw);
        if (!v.ok) {
          await showStepTip(ctx, 4);
          return replyCode(ctx, `⚠️ ${v.err}`);
        }

        const existsPerf = await db.query('SELECT 1 FROM shops WHERE performance_client_id = $1 LIMIT 1', [perf_client_id_raw]);
        if (existsPerf.rowCount) {
          await showStepTip(ctx, 4);
          return replyCode(ctx, '⚠️ Отказ: такой performance_client_id уже зарегистрирован. Укажите другой.');
        }

        state.performance_client_id = perf_client_id_raw;
        state.step = 5;

        await showStepTip(ctx, 5);
        return replyCode(ctx, 'Введите ваш performance_secret (secret_key) для Performance API:');
      }

      // 5) performance_secret + онлайн-проверка пары performance
      if (state.step === 5) {
        const perf_secret_raw = sanitizePerfSecret(ctx.message.text);
        const v = validatePerfSecret(perf_secret_raw);
        if (!v.ok) {
          await showStepTip(ctx, 5);
          return replyCode(ctx, `⚠️ ${v.err}`);
        }

        // онлайн-валидация рекламных ключей
        const ok = await verifyPerformanceCredentials(state.performance_client_id, perf_secret_raw);
        if (!ok) {
          // Возвращаем на шаг 4 просить рекламные ключи заново
          state.step = 4;
          await replyCode(ctx, '⚠️ Не удалось получить доступ к Ozon Performance. Проверьте корректность рекламных ключей.');
          await showStepTip(ctx, 4);
          return replyCode(ctx, 'Введите ваш performance_client_id для Performance API:');
        }

        state.performance_secret = perf_secret_raw;

        const first_name = ctx.from.first_name || '';
        const last_name  = ctx.from.last_name  || '';

        await db.query('BEGIN');

        // Повторные проверки на гонки
        const existsUser = await db.query('SELECT 1 FROM users WHERE client_id = $1 LIMIT 1', [state.client_id]);
        if (existsUser.rowCount) {
          await db.query('ROLLBACK');
          delete regSteps[chat_id];
          return replyCode(ctx, '⚠️ Отказ: такой client_id уже есть в базе пользователей. Регистрация прервана.');
        }
        const existsShopClient = await db.query('SELECT 1 FROM shops WHERE client_id = $1 LIMIT 1', [state.client_id]);
        if (existsShopClient.rowCount) {
          await db.query('ROLLBACK');
          delete regSteps[chat_id];
          return replyCode(ctx, '⚠️ Отказ: такой client_id уже привязан к магазину. Регистрация прервана.');
        }
        const existsPerf = await db.query('SELECT 1 FROM shops WHERE performance_client_id = $1 LIMIT 1', [state.performance_client_id]);
        if (existsPerf.rowCount) {
          await db.query('ROLLBACK');
          delete regSteps[chat_id];
          return replyCode(ctx, '⚠️ Отказ: такой performance_client_id уже зарегистрирован. Регистрация прервана.');
        }

        // users: upsert по chat_id
        await db.query(`
          INSERT INTO users (chat_id, client_id, seller_api, first_name, last_name, shop_name, is_subscribed, registered_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW(), NOW())
          ON CONFLICT (chat_id) DO UPDATE SET
            client_id     = EXCLUDED.client_id,
            seller_api    = EXCLUDED.seller_api,
            first_name    = EXCLUDED.first_name,
            last_name     = EXCLUDED.last_name,
            shop_name     = EXCLUDED.shop_name,
            is_subscribed = TRUE,
            updated_at    = NOW()
        `, [
          chat_id,
          state.client_id,
          state.seller_api,
          first_name,
          last_name,
          state.shop_name,
        ]);

        // shops: создаём запись с полями Performance API
        const shopIns = await db.query(
          `INSERT INTO shops (chat_id, client_id, name, performance_client_id, performance_secret, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           RETURNING id`,
          [chat_id, state.client_id, state.shop_name, state.performance_client_id, state.performance_secret]
        );
        const shopId = shopIns.rows[0]?.id;

        await db.query('COMMIT');

        // Вне транзакции: подтянуть остатки и апсертом обновить shop_products
        try {
          const items = await fetchStocksPositiveBySku({
            client_id: state.client_id,
            api_key:   state.seller_api,
          });

          if (shopId) {
            await db.query('BEGIN');

            await db.query('UPDATE shop_products SET quantity = 0 WHERE shop_id = $1', [shopId]);

            if (items.length) {
              const values = [];
              const params = [];
              let p = 1;

              for (const it of items) {
                values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
                params.push(
                  shopId,
                  it.sku,
                  String(it.title || ''),
                  Number(it.quantity || 0)
                );
              }

              await db.query(
                `INSERT INTO shop_products (shop_id, sku, title, quantity)
                 VALUES ${values.join(',')}
                 ON CONFLICT (shop_id, sku) DO UPDATE
                   SET title = EXCLUDED.title,
                       quantity = EXCLUDED.quantity`,
                params
              );
            }

            await db.query('COMMIT');
          }
        } catch (e) {
          try { await db.query('ROLLBACK'); } catch {}
          console.error('Ошибка загрузки/сохранения остатков:', e?.response?.data || e);
        }

        await replyCode(ctx, 'Вы успешно зарегистрированы!', mainMenu());
        delete regSteps[chat_id];
      }
    } catch (err) {
      try { await db.query('ROLLBACK'); } catch {}
      console.error('Ошибка регистрации:', err?.response?.data || err);
      await replyCode(ctx, '⚠️ Произошла ошибка при регистрации. Попробуйте ещё раз командой /start.');
      delete regSteps[chat_id];
    }
  });
};
