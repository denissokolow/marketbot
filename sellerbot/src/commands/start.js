const { replyCode, sendWelcomeCard, returningText } = require('../utils/replies');

module.exports.register = (bot, { pool, logger }) => {
  bot.start(async (ctx) => {
    const chatId = ctx.from?.id;
    try {
      const u = await pool.query('select * from users where chat_id=$1 limit 1', [chatId]);
      const user = u.rows[0];

      if (!user) {
        await sendWelcomeCard(ctx);                 // одинаково с /register
      } else {
        await replyCode(ctx, returningText(user, ctx.from));
      }
    } catch (e) {
      logger.error(e, 'start error');
      await replyCode(ctx, '⚠️ Произошла ошибка. Попробуйте позже.');
    }
  });
};
