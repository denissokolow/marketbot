// commands/settings.js
// ЕДИНСТВЕННАЯ задача этого файла — подключить модульный settings из ./settings/index.js,
// чтобы не ломать существующие кнопки/обработчики («Товары для отслеживания», «Себестоимость товаров» и т.п.).
// Дополнительно — безопасно добавляем команду /profile и callback settings:profile
// (не пересекается с вашим index.js и может быть вызвана из него одной кнопкой).

const { mainMenu } = require('../menu/menu.js');

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const replyCode = (ctx, text, extra = {}) =>
  ctx.reply(`<code>${esc(String(text))}</code>`, { parse_mode: 'HTML', ...extra });

const editCode = (ctx, text, extra = {}) =>
  ctx.editMessageText(`<code>${esc(String(text))}</code>`, { parse_mode: 'HTML', ...extra });

// Форматирование даты dd.mm.yyyy
function fmtDDMMYYYY(d) {
  try {
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return null;
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const yy = String(dt.getFullYear());
    return `${dd}.${mm}.${yy}`;
  } catch { return null; }
}

// Текст профиля
function profileText({ firstName, lastName, shopName, isSubscribed, untilText }) {
  const nameLine = `Имя: ${firstName || ''}${lastName ? ' ' + lastName : ''}`.trim();
  const shopLine = `Магазин: ${shopName || '—'}`;
  let subLine;
  if (isSubscribed === false) subLine = 'Подписка: не активна';
  else subLine = `Подписка: активна до ${untilText || '00.00.2025'}`;
  return `👤 Профиль
${nameLine}
${shopLine}
${subLine}`;
}

module.exports = (bot, db) => {
  // 1) Подключаем ВАШЕ модульное меню настроек — оно управляет /settings и всеми существующими кнопками.
  require('./settings/index.js')(bot, db);

  // 2) Добавляем "Профиль" как отдельную безопасную команду и callback,
  // чтобы вы могли повесить на неё кнопку в своём ./settings/index.js (callback_data: 'settings:profile'),
  // не ломая остальной функционал.

  // /profile — показать профиль
  bot.command('profile', async (ctx) => {
    try {
      const chat_id = ctx.from.id;
      const uRes = await db.query('SELECT * FROM users WHERE chat_id = $1 LIMIT 1', [chat_id]);
      const u = uRes.rows[0] || {};
      const firstName = (u.first_name || ctx.from.first_name || '').trim();
      const lastName  = (u.last_name  || ctx.from.last_name  || '').trim();

      const sRes = await db.query(
        'SELECT name FROM shops WHERE chat_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
        [chat_id]
      );
      const shopName = (sRes.rows[0]?.name || u.shop_name || '').trim();

      const isSubscribed = typeof u.is_subscribed === 'boolean' ? u.is_subscribed : true;
      let untilText = null;
      if (u.subscription_until) untilText = fmtDDMMYYYY(u.subscription_until);

      await replyCode(ctx, profileText({ firstName, lastName, shopName, isSubscribed, untilText }));
    } catch (e) {
      console.error('[settings/profile] /profile error:', e);
      await replyCode(ctx, 'Произошла ошибка. Попробуйте позже.', mainMenu());
    }
  });

  // callback: settings:profile — то же самое, но для инлайн-кнопки из вашего index.js
  bot.action('settings:profile', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const chat_id = ctx.from.id;
      const uRes = await db.query('SELECT * FROM users WHERE chat_id = $1 LIMIT 1', [chat_id]);
      const u = uRes.rows[0] || {};
      const firstName = (u.first_name || ctx.from.first_name || '').trim();
      const lastName  = (u.last_name  || ctx.from.last_name  || '').trim();

      const sRes = await db.query(
        'SELECT name FROM shops WHERE chat_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
        [chat_id]
      );
      const shopName = (sRes.rows[0]?.name || u.shop_name || '').trim();

      const isSubscribed = typeof u.is_subscribed === 'boolean' ? u.is_subscribed : true;
      let untilText = null;
      if (u.subscription_until) untilText = fmtDDMMYYYY(u.subscription_until);

      // Пытаемся отредактировать сообщение, если это меню; если нельзя — отправим новое
      try {
        await editCode(ctx, profileText({ firstName, lastName, shopName, isSubscribed, untilText }));
      } catch {
        await replyCode(ctx, profileText({ firstName, lastName, shopName, isSubscribed, untilText }));
      }
    } catch (e) {
      console.error('[settings/profile] callback error:', e);
      try { await ctx.answerCbQuery(); } catch {}
      await replyCode(ctx, 'Не удалось открыть профиль. Попробуйте позже.');
    }
  });
};
