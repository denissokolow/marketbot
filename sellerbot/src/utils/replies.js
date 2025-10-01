// Общие ответы/карточки
const { Markup } = require('telegraf');

// HTML <code>-ответ с экранированием
function esc(s = '') { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function replyCode(ctx, text, extra = {}) {
  return ctx.reply(`<code>${esc(String(text))}</code>`, { parse_mode: 'HTML', ...extra });
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

function returningText(user, from) {
  const first = (user?.first_name || from?.first_name || '').trim();
  const last  = (user?.last_name  || from?.last_name  || '').trim();
  const name  = [first, last].filter(Boolean).join(' ').trim() || 'друг';
  return `С возвращением, ${name}!
Воспользуйтесь кнопкой «Меню» (внизу слева) с командами для взаимодействия с ботом.`;
}

module.exports = { replyCode, welcomeTextNewUser, sendWelcomeCard, esc, returningText };
