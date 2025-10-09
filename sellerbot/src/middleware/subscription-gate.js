// src/middleware/subscription-gate.js
// Глобальный «шлюз подписки» для всех команд, кроме /settings и её подменю.

function isActiveByRow(row, now = new Date()) {
  const until = row?.subscription_until ? new Date(row.subscription_until) : null;
  if (until && until.getTime() >= now.getTime()) return true;
  // опционально: учитывать флаг is_subscribed, если включено
  if (process.env.USE_IS_SUBSCRIBED_FALLBACK === '1' && row?.is_subscribed === true) return true;
  return false;
}

async function getUserSubRow(pool, chatId) {
  const r = await pool.query(
    `SELECT subscription_until, is_subscribed FROM users WHERE chat_id = $1 LIMIT 1`,
    [chatId]
  );
  return r.rowCount ? r.rows[0] : null;
}

/**
 * @param {{ pool:any, logger?:any, expiredText?:string, whitelistCommands?:string[], allowCallbackPrefixes?:string[] }} opts
 */
module.exports = function subscriptionGate(opts) {
  const {
    pool,
    logger,
    expiredText = 'Ваша подписка истекла, её можно оплатить в меню (внизу слева) 👇 в разделе «Настройки».',
    // какие команды разрешены без подписки
    whitelistCommands = ['/settings'],
    // какие callbackQuery разрешены (подменю «Настройки» и их экшены)
    allowCallbackPrefixes = ['settings:', 'settings_', 'subs:', 'billing:', 'pay:', 'payment:'],
  } = opts || {};

  // небольшие хелперы
  const isWhitelistedCmd = (cmd) =>
    !!whitelistCommands.find((w) => cmd === w || cmd.startsWith(w + ' '));

  const isAllowedCallback = (data) =>
    !!allowCallbackPrefixes.find((p) => data.startsWith(p));

  return async (ctx, next) => {
    const chatId = ctx.from?.id;
    if (!chatId) return next(); // системные апдейты

    // Разрешаем все «не-командные» апдейты, кроме callbackQuery — их проверим отдельно
    const text = ctx.message?.text?.trim();
    const isCommand = !!(text && text.startsWith('/'));

    // 1) Всегда пропускаем /settings и её подменю
    if (isCommand) {
      const cmd = text.split(/\s+/, 1)[0]; // '/report', '/settings'
      if (isWhitelistedCmd(cmd)) return next();
    }
    if (ctx.callbackQuery?.data) {
      const data = String(ctx.callbackQuery.data);
      if (isAllowedCallback(data)) return next();
    }

    // 2) Любая другая команда/кнопка — проверяем подписку
    if (isCommand || ctx.callbackQuery) {
      // есть ли пользователь вообще?
      const userRow = await getUserSubRow(pool, chatId);
      if (!userRow) {
        // нет пользователя в БД — пусть обработают текущие команды (обычно /start → регистрация)
        return next();
      }

      const active = isActiveByRow(userRow);
      if (!active) {
        // подписка неактивна — показываем единое сообщение и гасим команду
        try {
          await ctx.reply(expiredText);
        } catch (e) {
          logger?.warn?.(e, '[subGate] reply error');
        }
        return; // НЕ вызываем next() → команда не дойдёт до своих хендлеров
      }
    }

    // 3) Всё остальное (не команды/не колбэки) пропускаем
    return next();
  };
};
