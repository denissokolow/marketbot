// commands/register.js
// commands/register.js
const { mainMenu } = require('../menu/menu.js');
const { fetchStocksPositiveBySku } = require('../ozon');

const regSteps = Object.create(null);

module.exports = (bot, db) => {
  // /start — начало регистрации или приветствие уже зарегистрированному
  bot.start(async (ctx) => {
    const chat_id = ctx.from.id;

    const uRes = await db.query('SELECT * FROM users WHERE chat_id = $1 LIMIT 1', [chat_id]);
    const user = uRes.rows[0];

    if (user) {
      const sRes = await db.query(
        'SELECT name FROM shops WHERE chat_id = $1 ORDER BY created_at DESC, id DESC',
        [chat_id]
      );
      const shopNames = sRes.rows.map(r => r.name).filter(Boolean);
      const shopsLine = shopNames.length ? `\nВаши магазины: ${shopNames.join(', ')}` : '';

      await ctx.reply(
        `Привет, ${user.first_name || ctx.from.first_name || 'друг'}!\n` +
        `Вы уже зарегистрированы.${shopsLine}`,
        mainMenu()
      );
      return;
    }

    regSteps[chat_id] = { step: 1 };
    await ctx.reply('Добро пожаловать! Введите название вашего магазина на Ozon:');
  });

  // Пошаговая регистрация
  bot.on('text', async (ctx) => {
    const chat_id = ctx.from.id;
    const state = regSteps[chat_id];
    if (!state || ctx.message.text.startsWith('/')) return;

    try {
      // 1. Название магазина
      if (state.step === 1) {
        state.shop_name = (ctx.message.text || '').trim();
        if (!state.shop_name) return ctx.reply('Название не должно быть пустым. Введите название магазина:');
        state.step = 2;
        return ctx.reply('Введите ваш client_id:');
      }

      // 2. client_id (уникальность по users.client_id)
      if (state.step === 2) {
        const client_id = (ctx.message.text || '').trim();
        if (!client_id) return ctx.reply('client_id не должен быть пустым. Введите client_id:');

        const exists = await db.query('SELECT 1 FROM users WHERE client_id = $1 LIMIT 1', [client_id]);
        if (exists.rowCount) return ctx.reply('Такой client_id уже зарегистрирован. Укажите другой client_id:');

        state.client_id = client_id;
        state.step = 3;
        return ctx.reply('Введите ваш api_key:');
      }

      // 3. api_key → пишем в users, создаём запись в shops, тянем остатки и сохраняем в shop_products
      if (state.step === 3) {
        state.seller_api = (ctx.message.text || '').trim();
        if (!state.seller_api) return ctx.reply('api_key не должен быть пустым. Введите api_key:');

        const first_name = ctx.from.first_name || '';
        const last_name  = ctx.from.last_name  || '';

        // транзакция: upsert в users, insert в shops (если нет)
        await db.query('BEGIN');

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

        const shopIns = await db.query(
          `INSERT INTO shops (chat_id, client_id, name, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [chat_id, state.client_id, state.shop_name]
        );

        let shopId;
        if (shopIns.rowCount) {
          shopId = shopIns.rows[0].id;
        } else {
          const s = await db.query(
            `SELECT id FROM shops WHERE chat_id = $1 AND client_id = $2 AND name = $3 LIMIT 1`,
            [chat_id, state.client_id, state.shop_name]
          );
          shopId = s.rows[0]?.id;
        }

        await db.query('COMMIT');

        // Вне транзакции: подтянуть остатки и пересобрать shop_products
        try {
          const items = await fetchStocksPositiveBySku({
            client_id: state.client_id,
            api_key: state.seller_api,
          });

          if (shopId) {
            // Полная пересборка ассортимента магазина
            await db.query('DELETE FROM shop_products WHERE shop_id = $1', [shopId]);

            if (items.length) {
              const values = [];
              const params = [];
              let p = 1;

              for (const it of items) {
                values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
                params.push(shopId, it.sku, it.title, it.quantity);
              }

              await db.query(
                `INSERT INTO shop_products (shop_id, sku, title, quantity) VALUES ${values.join(',')}`,
                params
              );
            }
          }
        } catch (e) {
          console.error('Ошибка загрузки/сохранения остатков:', e?.response?.data || e);
          // регистрация всё равно завершена
        }

        await ctx.reply('Вы успешно зарегистрированы!', mainMenu());
        delete regSteps[chat_id];
      }
    } catch (err) {
      try { await db.query('ROLLBACK'); } catch {}
      console.error('Ошибка регистрации:', err?.response?.data || err);
      await ctx.reply('Произошла ошибка при регистрации. Попробуйте ещё раз командой /start.');
      delete regSteps[chat_id];
    }
  });
};
