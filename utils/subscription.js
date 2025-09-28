// utils/subscription.js
const { Markup } = require('telegraf');

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function welcomeTextNewUser() {
  const text =
`Добро пожаловать в Озон Селлер Курьер! 👋

Наш бот помогает получать данные из кабинета Ozon в удобном виде,
присылает ежедневную сводку о магазине и товарах, а также аналитику
по каждой позиции и сводную. Проводит ABC-анализ товаров и показывает проблемные места.

Вы можете ознакомиться с функционалом и тарифами:

🎞️ Видео https://telegra.ph/123-09-24-73

📰 Текст и изображения https://telegra.ph/123-09-24-73

Или сразу перейдите к регистрации, нажав кнопку «Регистрация» под сообщением. 👇`;
  return `<code>${esc(text)}</code>`;
}

function registrationKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Регистрация', 'register_begin')],
  ]);
}

/**
 * Показывает приветствие, если пользователь НЕ зарегистрирован.
 * Возвращает:
 *  - true  — зарегистрирован, можно продолжать
 *  - false — уже показали приветствие, дальше идти не надо
 */
async function ensureRegisteredOrWelcome(ctx, db) {
  const chat_id = ctx.from?.id;
  if (!chat_id) return false;
  const r = await db.query('SELECT 1 FROM users WHERE chat_id = $1 LIMIT 1', [chat_id]);
  if (!r.rowCount) {
    await ctx.reply(welcomeTextNewUser(), {
      parse_mode: 'HTML',
      reply_markup: registrationKeyboard().reply_markup,
    });
    return false;
  }
  return true;
}

/**
 * Проверка платной подписки для зарегистрированных.
 * Если подписка не активна — отправляем заглушку.
 * Если пользователь не зарегистрирован — показываем приветствие.
 */
async function assertSubscribedOrReply(ctx, db) {
  const chat_id = ctx.from?.id;
  if (!chat_id) return false;

  const r = await db.query(
    'SELECT is_subscribed FROM users WHERE chat_id = $1 LIMIT 1',
    [chat_id]
  );

  // Незарегистрирован — показываем приветствие
  if (!r.rowCount) {
    await ctx.reply(welcomeTextNewUser(), {
      parse_mode: 'HTML',
      reply_markup: registrationKeyboard().reply_markup,
    });
    return false;
  }

  // Зарегистрирован, но без подписки
  if (r.rows[0].is_subscribed !== true) {
    await ctx.reply(
      'Вы не можете посмотреть этот отчёт, так как Ваша подписка не активна.\n' +
      'Активировать подписку Вы можете в меню «Настройки».'
    );
    return false;
  }

  return true;
}

module.exports = {
  ensureRegisteredOrWelcome,
  assertSubscribedOrReply,
};
