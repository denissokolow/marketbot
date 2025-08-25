// commands/register.js
const { mainMenu } = require('../menu/menu.js');
const { fetchStocksPositiveBySku } = require('../ozon');

const regSteps = Object.create(null);

// маленькие хелперы
const trim = (s) => String(s || '').trim();

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

    // не в процессе регистрации — выходим
    if (!state || ctx.message.text.startsWith('/')) return;

    try {
      // 1) Название магазина
      if (state.step === 1) {
        state.shop_name = trim(ctx.message.text);
        if (!state.shop_name) return ctx.reply('Название не должно быть пустым. Введите название магазина:');
        state.step = 2;
        return ctx.reply('Введите ваш client_id для Seller API:');
      }

      // 2) client_id (обычный). Проверяем уникальность в users.client_id и shops.client_id
      if (state.step === 2) {
        const client_id = trim(ctx.message.text);
        if (!client_id) return ctx.reply('client_id не должен быть пустым. Введите client_id:');

        const existsUser = await db.query('SELECT 1 FROM users WHERE client_id = $1 LIMIT 1', [client_id]);
        if (existsUser.rowCount) {
          return ctx.reply('Отказ: такой client_id уже есть в базе пользователей. Укажите другой client_id.');
        }

        const existsShopClient = await db.query('SELECT 1 FROM shops WHERE client_id = $1 LIMIT 1', [client_id]);
        if (existsShopClient.rowCount) {
          return ctx.reply('Отказ: такой client_id уже привязан к магазину. Укажите другой client_id.');
        }

        state.client_id = client_id;
        state.step = 3;
        return ctx.reply('Введите ваш api_key для Seller API:');
      }

      // 3) api_key (обычный)
      if (state.step === 3) {
        state.seller_api = trim(ctx.message.text);
        if (!state.seller_api) return ctx.reply('api_key не должен быть пустым. Введите api_key:');

        state.step = 4;
        return ctx.reply('Введите ваш performance_client_id для Performance API:');
      }

      // 4) performance_client_id. Проверяем уникальность в shops.performance_client_id
      if (state.step === 4) {
        const perf_client_id = trim(ctx.message.text);
        if (!perf_client_id) {
          return ctx.reply('performance_client_id не должен быть пустым. Введите performance_client_id:');
        }

        const existsPerf = await db.query(
          'SELECT 1 FROM shops WHERE performance_client_id = $1 LIMIT 1',
          [perf_client_id]
        );
        if (existsPerf.rowCount) {
          return ctx.reply('Отказ: такой performance_client_id уже зарегистрирован. Укажите другой.');
        }

        state.performance_client_id = perf_client_id;
        state.step = 5;
        return ctx.reply('Введите ваш performance_secret (secret_key) для Performance API:');
      }

      // 5) performance_secret -> запись в базу (users + shops), затем подтягиваем остатки
      if (state.step === 5) {
        state.performance_secret = trim(ctx.message.text);
        if (!state.performance_secret) {
          return ctx.reply('secret_key не должен быть пустым. Введите корректный secret_key:');
        }

        const first_name = ctx.from.first_name || '';
        const last_name  = ctx.from.last_name  || '';

        // Транзакция: upsert в users, затем вставка в shops с доп. полями Performance API
        await db.query('BEGIN');

        // — ещё раз защитимся от гонки (вдруг параллельно кто-то занял client_id)
        const existsUser = await db.query('SELECT 1 FROM users WHERE client_id = $1 LIMIT 1', [state.client_id]);
        if (existsUser.rowCount) {
          await db.query('ROLLBACK');
          delete regSteps[chat_id];
          return ctx.reply('Отказ: такой client_id уже есть в базе пользователей. Регистрация прервана.');
        }
        const existsShopClient = await db.query('SELECT 1 FROM shops WHERE client_id = $1 LIMIT 1', [state.client_id]);
        if (existsShopClient.rowCount) {
          await db.query('ROLLBACK');
          delete regSteps[chat_id];
          return ctx.reply('Отказ: такой client_id уже привязан к магазину. Регистрация прервана.');
        }
        const existsPerf = await db.query(
          'SELECT 1 FROM shops WHERE performance_client_id = $1 LIMIT 1',
          [state.performance_client_id]
        );
        if (existsPerf.rowCount) {
          await db.query('ROLLBACK');
          delete regSteps[chat_id];
          return ctx.reply('Отказ: такой performance_client_id уже зарегистрирован. Регистрация прервана.');
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
        // если у вас есть уникальные ограничения — можно заменить на конкретный ON CONFLICT(...)
        const shopIns = await db.query(
          `INSERT INTO shops (chat_id, client_id, name, performance_client_id, performance_secret, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           RETURNING id`,
          [chat_id, state.client_id, state.shop_name, state.performance_client_id, state.performance_secret]
        );
        const shopId = shopIns.rows[0]?.id;

        await db.query('COMMIT');

        // Вне транзакции: подтянуть остатки и пересобрать shop_products
        try {
          const items = await fetchStocksPositiveBySku({
            client_id: state.client_id,
            api_key: state.seller_api,
          });

          if (shopId) {
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
