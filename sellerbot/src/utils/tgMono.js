// src/utils/tgMono.js
// Отправляет длинный текст как несколько сообщений, каждое целиком в моноширинном шрифте,
// без parse_mode — только через message entities (pre).
// Так Telegram ничего не "ломает", даже с эмодзи.

const HARD_LIMIT = 4096;   // Telegram limit
const SAFE_LIMIT = 4000;   // запас на эмодзи/служебные символы

function chunkUtf16(str, max = SAFE_LIMIT) {
  const chunks = [];
  let i = 0;
  while (i < str.length) {
    chunks.push(str.slice(i, i + max));
    i += max;
  }
  return chunks;
}

async function sendPre(ctx, text, opts = {}) {
  const chunks = chunkUtf16(String(text), SAFE_LIMIT);
  for (const ch of chunks) {
    // ВАЖНО: НЕ указываем parse_mode
    await ctx.telegram.sendMessage(
      ctx.chat.id,
      ch,
      {
        entities: [{ type: 'pre', offset: 0, length: ch.length }],
        disable_web_page_preview: true,
        ...opts,
      }
    );
  }
}

module.exports = { sendPre };
