// commands/graph.js
module.exports = (bot /*, db */) => {
  const esc = (s = '') => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const replyCode = (ctx, text, extra = {}) =>
    ctx.reply(`<code>${esc(String(text))}</code>`, { parse_mode: 'HTML', ...extra });

  bot.command('graph', async (ctx) => {
    const text =
`📊 Графики (заготовка)

Скоро здесь будут:
• ABC-график по выручке
• Тренды выручки/прибыльности
• Эффективность рекламы

Пока ABC-рейтинги уже доступны в отчётах /mtd и /last30.`;
    await replyCode(ctx, text);
  });
};
