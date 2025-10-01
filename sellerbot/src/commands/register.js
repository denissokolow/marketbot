//src/commands/register.js
const axios = require('axios');
const { replyCode, sendWelcomeCard } = require('../utils/replies');
const { request: ozonRequest } = require('../services/ozon/client');
const regSteps = Object.create(null);
const fs = require('fs');
const path = require('path');

// --- утилиты и валидации ---
const MIN_SHOP_NAME_LEN = 2;
const MAX_SHOP_NAME_LEN = Number(process.env.SHOP_NAME_MAX_LEN || 80);
const CLIENT_ID_MAX_LEN = Number(process.env.CLIENT_ID_MAX_LEN || 16);
const API_KEY_MAX_LEN   = Number(process.env.API_KEY_MAX_LEN || 128);
const PERF_ID_MAX_LEN   = Number(process.env.PERF_CLIENT_ID_MAX_LEN || 128);
const PERF_SEC_MAX_LEN  = Number(process.env.PERF_SECRET_MAX_LEN || 256);
const PERF_SEC_MIN_LEN  = Number(process.env.PERF_SECRET_MIN_LEN || 16);
const VERIFY_SELLER     = process.env.VERIFY_SELLER_KEYS !== '0';
const VERIFY_PERF       = process.env.VERIFY_PERF_KEYS   !== '0';

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
    caption: `<code>${String(caption).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code>`,
    parse_mode: 'HTML',
  });
}

// ENV-ключи с картинками для каждого шага
const PHOTO_CLIENT_ID_TIP      = process.env.PHOTO_CLIENT_ID_TIP || null;      // шаг 2
const PHOTO_API_KEY_TIP        = process.env.PHOTO_API_KEY_TIP || null;        // шаг 3
const PHOTO_PERF_CLIENT_ID_TIP = process.env.PHOTO_PERF_CLIENT_ID_TIP || null; // шаг 4
const PHOTO_PERF_SECRET_TIP    = process.env.PHOTO_PERF_SECRET_TIP || null;    // шаг 5

// Показать подсказку для текущего шага
async function showStepTip(ctx, step) {
  try {
    if (step === 2) {
      await replyPhotoCode(ctx, PHOTO_CLIENT_ID_TIP, 'Где найти client_id: ЛК Ozon → Настройки → API-доступ.');
    } else if (step === 3) {
      await replyPhotoCode(ctx, PHOTO_API_KEY_TIP, 'Где найти api_key: ЛК Ozon → Настройки → API-доступ.');
    } else if (step === 4) {
      await replyPhotoCode(ctx, PHOTO_PERF_CLIENT_ID_TIP, 'Performance client_id: Ozon Performance → Настройки → API-доступ.');
    } else if (step === 5) {
      await replyPhotoCode(ctx, PHOTO_PERF_SECRET_TIP, 'Performance secret_key: Ozon Performance → Настройки → API-доступ.');
    }
  } catch (e) {
    // не роняем поток регистрации из-за картинок
    console.warn(`[register] step ${step} tip failed:`, e?.message || e);
  }
}

function sanitizeShopName(raw) {
  let s = String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ')
                           .normalize('NFC').replace(/\s+/g, ' ').trim();
  if (s.length > MAX_SHOP_NAME_LEN) s = s.slice(0, MAX_SHOP_NAME_LEN);
  return s;
}
function validateShopName(s) {
  if (!s) return { ok: false, err: 'Название не должно быть пустым. Введите название магазина:' };
  if (s.length < MIN_SHOP_NAME_LEN) return { ok: false, err: `Слишком короткое название (минимум ${MIN_SHOP_NAME_LEN} символа).` };
  if (!/[0-9A-Za-zА-Яа-яЁё]/.test(s)) return { ok: false, err: 'Название должно содержать буквы или цифры.' };
  return { ok: true };
}
const sanitizeClientId = raw => String(raw ?? '').replace(/\s+/g, '').trim();
function validateClientId(s) {
  if (!s) return { ok: false, err: 'client_id не должен быть пустым. Введите client_id:' };
  if (!/^\d+$/.test(s)) return { ok: false, err: 'client_id должен состоять только из цифр.' };
  if (s.length > CLIENT_ID_MAX_LEN) return { ok: false, err: `Слишком длинный client_id (максимум ${CLIENT_ID_MAX_LEN} цифр).` };
  return { ok: true };
}
const sanitizeApiKey = raw => String(raw ?? '').trim();
function validateApiKey(s) {
  if (!s) return { ok: false, err: 'api_key не должен быть пустым. Введите api_key:' };
  if (s.length > API_KEY_MAX_LEN) return { ok: false, err: `Слишком длинный api_key (максимум ${API_KEY_MAX_LEN} символов).` };
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidLike.test(s)) return { ok: false, err: 'api_key должен быть в формате UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.' };
  return { ok: true };
}
const sanitizePerfId = raw => String(raw ?? '').trim();
function validatePerfId(s) {
  if (!s) return { ok: false, err: 'performance_client_id не должен быть пустым. Введите performance_client_id:' };
  if (s.length > PERF_ID_MAX_LEN) return { ok: false, err: `Слишком длинный performance_client_id (максимум ${PERF_ID_MAX_LEN} символов).` };
  const simple = /^[A-Za-z0-9._-]+$/;
  const emaily = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  if (!simple.test(s) && !emaily.test(s)) return { ok: false, err: 'Допустимы латиница/цифры/._- или формат name@domain.tld.' };
  return { ok: true };
}
const sanitizePerfSecret = raw => String(raw ?? '').trim();
function validatePerfSecret(s) {
  if (!s) return { ok: false, err: 'secret_key не должен быть пустым. Введите корректный secret_key:' };
  if (s.length < PERF_SEC_MIN_LEN) return { ok: false, err: `Слишком короткий secret_key (минимум ${PERF_SEC_MIN_LEN} символов).` };
  if (s.length > PERF_SEC_MAX_LEN) return { ok: false, err: `Слишком длинный secret_key (максимум ${PERF_SEC_MAX_LEN} символов).` };
  if (!/^[A-Za-z0-9._\-=]+$/.test(s)) return { ok: false, err: 'secret_key может содержать только латиницу, цифры и символы . _ - =' };
  return { ok: true };
}

// вчера (YYYY-MM-DD UTC), для seller-пинга
function getYesterdayISO() {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// онлайн-проверки ключей (можно отключить переменными окружения)
async function verifySellerCredentials(client_id, api_key) {
  if (!VERIFY_SELLER) return true;
  const y = getYesterdayISO();
  try {
    await ozonRequest('/v1/analytics/data', {
      date_from: y, date_to: y, metrics: ['revenue'], dimension: ['sku'], limit: 1, offset: 0,
    }, { client_id, api_key });
    return true;
  } catch {
    return false;
  }
}
async function verifyPerformanceCredentials(perf_client_id, perf_secret) {
  if (!VERIFY_PERF) return true;
  try {
    const r = await axios.post(
      'https://api-performance.ozon.ru/api/client/token',
      { client_id: perf_client_id, client_secret: perf_secret, grant_type: 'client_credentials' },
      { headers: { 'Content-Type': 'application/json' }, timeout: 8000 }
    );
    return Boolean(r?.data?.access_token || r?.data?.token);
  } catch {
    return false;
  }
}

// --- команда ---
module.exports.register = (bot, { pool, logger }) => {
  // /register — если не зарегистрирован, показываем ту же welcome-карточку
  bot.command('register', async (ctx) => {
    const chatId = ctx.from?.id;
    try {
      const u = await pool.query('select id from users where chat_id=$1 limit 1', [chatId]);
      if (!u.rowCount) {
        await sendWelcomeCard(ctx);                 // то же сообщение, что и /start
        return;
      }
      await replyCode(ctx, 'Вы уже зарегистрированы. Используйте меню команд для работы.');
    } catch (e) {
      logger.error(e, 'register entry error');
      await replyCode(ctx, '⚠️ Ошибка. Попробуйте позже.');
    }
  });
// кнопка «Регистрация» — запуск пошаговой регистрации
bot.action('register_begin', async (ctx) => {
  try {
    await ctx.answerCbQuery(); // закрыть "Загрузка…"

    const chatId = ctx.from.id;

    // уже зарегистрирован?
    const u = await pool.query('select id from users where chat_id=$1 limit 1', [chatId]);
    if (u.rowCount) {
      await replyCode(ctx, 'Вы уже зарегистрированы. Откройте «Меню» для работы.');
      return;
    }

    // стартуем мастер
    regSteps[chatId] = { step: 1 };
    await replyCode(ctx, 'Введите название вашего магазина на Ozon:');
  } catch (e) {
    logger.error(e, 'register_begin error');
    await replyCode(ctx, '⚠️ Не удалось начать регистрацию. Попробуйте ещё раз.');
  }
});
// пошаговая регистрация (НЕ глушим команды — используем next())
bot.on('text', async (ctx, next) => {
  const chatId = ctx.from?.id;
  const text = ctx.message?.text || '';
  const state = regSteps[chatId];

  // если не в процессе регистрации ИЛИ это команда — пропускаем дальше
  if (!state || text.startsWith('/')) return next();

  try {
    // 1) shop name
    if (state.step === 1) {
      const s = sanitizeShopName(text);
      const v = validateShopName(s);
      if (!v.ok) {
        await replyCode(ctx, `⚠️ ${v.err}`);
        return;
      }
      state.shop_name = s;
      state.step = 2;
      await showStepTip(ctx, 2);
      await replyCode(ctx, 'Введите ваш client_id для Seller API:');
      return;
    }

    // 2) client_id
    if (state.step === 2) {
      const cid = sanitizeClientId(text);
      const v = validateClientId(cid);
      if (!v.ok) {
        await showStepTip(ctx, 2);
        await replyCode(ctx, `⚠️ ${v.err}`);
        return;
      }

      // Не даём использовать client_id, который уже привязан к другому магазину
      const ex = await pool.query('select 1 from shops where ozon_client_id = $1 limit 1', [cid]);
      if (ex.rowCount) {
        await showStepTip(ctx, 2);
        await replyCode(ctx, '⚠️ Такой client_id уже используется. Укажите другой.');
        return;
      }

      state.client_id = cid;
      state.step = 3;
      await showStepTip(ctx, 3);
      await replyCode(ctx, 'Введите ваш api_key для Seller API:');
      return;
    }

    // 3) api_key + онлайн-проверка пары seller
    if (state.step === 3) {
      const key = sanitizeApiKey(text);
      const v = validateApiKey(key);
      if (!v.ok) {
        await showStepTip(ctx, 3);
        await replyCode(ctx, `⚠️ ${v.err}`);
        return;
      }

      const ok = await verifySellerCredentials(state.client_id, key);
      if (!ok) {
        // Откат НА ШАГ 2 + подсказка
        state.step = 2;
        state.client_id = undefined;
        await replyCode(ctx, '⚠️ Не удалось авторизоваться в Seller API. Проверьте client_id и api_key.');
        await showStepTip(ctx, 2);
        await replyCode(ctx, 'Введите ваш client_id для Seller API:');
        return;
      }

      state.api_key = key;
      state.step = 4;
      await showStepTip(ctx, 4);
      await replyCode(ctx, 'Введите ваш performance_client_id для Performance API:');
      return;
    }

    // 4) perf_client_id
    if (state.step === 4) {
      const pid = sanitizePerfId(text);
      const v = validatePerfId(pid);
      if (!v.ok) {
        await showStepTip(ctx, 4);
        await replyCode(ctx, `⚠️ ${v.err}`);
        return;
      }

      const ex = await pool.query('select 1 from shops where perf_client_id = $1 limit 1', [pid]);
      if (ex.rowCount) {
        await showStepTip(ctx, 4);
        await replyCode(ctx, '⚠️ Такой performance_client_id уже используется. Укажите другой.');
        return;
      }

      state.perf_client_id = pid;
      state.step = 5;
      await showStepTip(ctx, 5);
      await replyCode(ctx, 'Введите ваш performance_secret (secret_key) для Performance API:');
      return;
    }

    // 5) perf_secret + онлайн-проверка
    if (state.step === 5) {
      const sec = sanitizePerfSecret(text);
      const v = validatePerfSecret(sec);
      if (!v.ok) {
        await showStepTip(ctx, 5);
        await replyCode(ctx, `⚠️ ${v.err}`);
        return;
      }

      const ok = await verifyPerformanceCredentials(state.perf_client_id, sec);
      if (!ok) {
        // Откат НА ШАГ 4 + подсказка
        state.step = 4;
        await replyCode(ctx, '⚠️ Не удалось подтвердить доступ к Ozon Performance. Повторите данные.');
        await showStepTip(ctx, 4);
        await replyCode(ctx, 'Введите ваш performance_client_id для Performance API:');
        return;
      }

      // Сохраняем в БД
      const first_name = ctx.from.first_name || null;
      const last_name  = ctx.from.last_name  || null;

      await pool.query('BEGIN');

      // users: upsert по chat_id
      const u = await pool.query(
        `insert into users (chat_id, first_name, last_name, is_subscribed, created_at)
         values ($1, $2, $3, false, now())
         on conflict (chat_id) do update set
           first_name = excluded.first_name,
           last_name  = excluded.last_name
         returning id`,
        [chatId, first_name, last_name]
      );
      const userId = u.rows[0].id;

      // shops: 1 пользователь → 1 магазин (unique user_id)
      await pool.query(
        `insert into shops (user_id, name, ozon_client_id, ozon_api_key, perf_client_id, perf_client_secret, created_at)
         values ($1, $2, $3, $4, $5, $6, now())
         on conflict (user_id) do update set
           name               = excluded.name,
           ozon_client_id     = excluded.ozon_client_id,
           ozon_api_key       = excluded.ozon_api_key,
           perf_client_id     = excluded.perf_client_id,
           perf_client_secret = excluded.perf_client_secret`,
        [userId, state.shop_name, state.client_id, state.api_key, state.perf_client_id, sec]
      );

      await pool.query('COMMIT');

      await replyCode(ctx, 'Вы успешно зарегистрированы! Откройте кнопку «Меню» для работы.');
      delete regSteps[chatId];
      return;
    }

    // нераспознанный шаг — сбросим состояние и пропустим дальше
    delete regSteps[chatId];
    return next();

  } catch (e) {
    try { await pool.query('ROLLBACK'); } catch {}
    logger.error(e, 'register flow error');
    delete regSteps[chatId];
    await replyCode(ctx, '⚠️ Произошла ошибка при регистрации. Попробуйте /register ещё раз.');
  }
});
}
