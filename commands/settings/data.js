// commands/settings/data.js
const { fetchStocksPositiveBySku } = require('../../ozon');

// ---------- общие выборки ----------
async function getUserByChat(db, chatId) {
  const r = await db.query('SELECT * FROM users WHERE chat_id = $1 LIMIT 1', [chatId]);
  return r?.rows?.[0] || null;
}

async function getShopsByChat(db, chatId) {
  const r = await db.query(
    'SELECT * FROM shops WHERE chat_id = $1 ORDER BY created_at DESC, id DESC',
    [chatId]
  );
  return r?.rows || [];
}

async function getShopById(db, shopId) {
  const r = await db.query('SELECT * FROM shops WHERE id = $1 LIMIT 1', [shopId]);
  return r?.rows?.[0] || null;
}

// список товаров магазина (для меню выбора)
async function getShopProductsPage(db, shopId, page = 1, pageSize = 20) {
  const offset = Math.max(0, (Number(page) - 1) * Number(pageSize));

  const totalRes = await db.query(
    `SELECT COUNT(*)::int AS cnt
       FROM shop_products
      WHERE shop_id = $1 AND quantity > 0`,
    [shopId]
  );

  const rowsRes = await db.query(
    `SELECT
        (sku)::bigint               AS sku,
        COALESCE(title, '')         AS title,
        quantity::int               AS quantity,
        (tracked)::boolean          AS tracked,   -- ВАЖНО: ИМЯ КАК В UI
        COALESCE(net, 0)::numeric   AS net
       FROM shop_products
      WHERE shop_id = $1 AND quantity > 0
      ORDER BY sku
      LIMIT $2 OFFSET $3`,
    [shopId, pageSize, offset]
  );

  return { items: rowsRes.rows, total: totalRes.rows[0].cnt };
}

// переключить галочку отслеживания в shop_products
async function toggleTracked(db, shopId, sku) {
  await db.query(
    `UPDATE shop_products
       SET tracked = NOT tracked
     WHERE shop_id = $1
       AND sku::text = $2::text`,
    [shopId, String(sku)]
  );
}

// страница активных (отслеживаемых) товаров с текущим остатком > 0
async function getActiveTrackedPage(db, shopId, page = 1, pageSize = 20) {
  const offset = Math.max(0, (Number(page) - 1) * Number(pageSize));

  const totalRes = await db.query(
    `SELECT COUNT(*)::int AS cnt
       FROM shop_products
      WHERE shop_id = $1
        AND tracked = TRUE
        AND quantity > 0`,
    [shopId]
  );

  const rowsRes = await db.query(
    `SELECT
        (sku)::bigint               AS sku,
        COALESCE(title,'')          AS title,
        quantity::int               AS quantity,
        (tracked)::boolean          AS tracked,   -- ключевой флаг
        COALESCE(net,0)::numeric    AS net
       FROM shop_products
      WHERE shop_id = $1
        AND tracked = TRUE
        AND quantity > 0
      ORDER BY sku
      LIMIT $2 OFFSET $3`,
    [shopId, pageSize, offset]
  );

  return { items: rowsRes.rows, total: totalRes.rows[0].cnt };
}

// установить/обновить себестоимость товара в рамках магазина
async function setNetForTracked(db, shopId, sku, net) {
  await db.query(
    `UPDATE shop_products
        SET net = $3
      WHERE shop_id = $1
        AND sku::text = $2::text`,
    [shopId, String(sku), Number(net) || 0]
  );
}

// ---------- добавление магазина с синхронизацией ассортимента ----------
async function addShopWithSync(db, chatId, { client_id, api_key, shop_name }) {
  // запретим дубликаты магазинов по (chat_id, client_id)
  const already = await db.query('SELECT 1 FROM shops WHERE chat_id = $1 LIMIT 1', [chat_id]);
  if (already.rowCount) {
    const err = new Error('only_one_shop_per_chat');
    err.code = 'only_one_shop_per_chat';
    throw err;
  }

  const exists = await db.query(
    'SELECT 1 FROM shops WHERE chat_id=$1 AND client_id=$2 LIMIT 1',
    [chatId, client_id]
  );
  if (exists.rowCount) {
    const err = new Error('shop_exists');
    err.code = 'shop_exists';
    throw err;
  }

  // создаём запись магазина
  const ins = await db.query(
    `INSERT INTO shops (chat_id, client_id, name, created_at)
     VALUES ($1, $2, $3, NOW())
     RETURNING id`,
    [chatId, client_id, shop_name || null]
  );
  const shopId = ins.rows[0].id;

  // 1) тянем все товары с остатком > 0 из Ozon
  let items = [];
  try {
    items = await fetchStocksPositiveBySku({ client_id, api_key }); // [{ sku, title, quantity }]
  } catch (e) {
    console.error('[addShopWithSync] fetchStocksPositiveBySku error:', e?.response?.data || e);
    // если не получилось подтянуть товары — магазин уже создан; просто выходим
    return shopId;
  }

  // 2) пересобираем shop_products и сразу помечаем все товары как отслеживаемые
  try {
    await db.query('BEGIN');

    // пересоздаём список товаров магазина
    await db.query('DELETE FROM shop_products WHERE shop_id=$1', [shopId]);

    if (items.length) {
      const values = [];
      const params = [];
      let p = 1;
      for (const it of items) {
        values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(shopId, it.sku, String(it.title || ''), Number(it.quantity || 0));
      }
      await db.query(
        `INSERT INTO shop_products (shop_id, sku, title, quantity) VALUES ${values.join(',')}`,
        params
      );

      // добавить ВСЕ позиции в tracked_products с is_active=TRUE (только новые на случай повторного вызова)
      await db.query(
        `
        INSERT INTO tracked_products (shop_id, sku, is_active)
        SELECT sp.shop_id, sp.sku, TRUE
        FROM shop_products sp
        LEFT JOIN tracked_products tp
          ON tp.shop_id = sp.shop_id AND tp.sku = sp.sku
        WHERE sp.shop_id = $1
          AND tp.id IS NULL
        `,
        [shopId]
      );
    }

    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    console.error('[addShopWithSync] DB sync error:', e?.response?.data || e);
    // не падаем — магазин уже создан
  }

  return shopId;
}


// ---------- глубокое удаление магазина ----------
async function deleteShopDeep(db, chatId, shopId) {
  // проверим владение
  const own = await db.query(
    'SELECT 1 FROM shops WHERE id=$1 AND chat_id=$2 LIMIT 1',
    [shopId, chatId]
  );
  if (!own.rowCount) {
    const err = new Error('shop_not_found');
    err.code = 'shop_not_found';
    throw err;
  }

  await db.query('BEGIN');
  try {
    // порядок не важен, но удалим дочерние таблицы явно
    await db.query('DELETE FROM tracked_products WHERE shop_id = $1', [shopId]);
    await db.query('DELETE FROM shop_products   WHERE shop_id = $1', [shopId]);
    await db.query('DELETE FROM shops           WHERE id = $1 AND chat_id = $2', [shopId, chatId]);
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}
// обновить shop_products для магазина из Ozon (все товары с ненулевым остатком)
// + не трогаем tracked у существующих, новые — tracked=TRUE (дефолт)
async function refreshShopProductsFromOzon(db, shopId) {
  // 1) креды Seller API
  const r = await db.query(
    `SELECT s.id AS shop_id,
            s.client_id::text AS client_id,
            s.chat_id,
            u.seller_api
       FROM shops s
       JOIN users u
         ON u.chat_id = s.chat_id
        AND u.client_id::text = s.client_id::text
      WHERE s.id = $1
      LIMIT 1`,
    [shopId]
  );
  if (!r.rowCount) throw new Error('shop_not_found');
  const { client_id, seller_api } = r.rows[0];

  // 2) актуальные остатки
  const items = await fetchStocksPositiveBySku({ client_id, api_key: seller_api }); // [{sku,title,quantity}]

  await db.query('BEGIN');

  // 3) обнуляем quantity у всех, потом зальём положительные
  await db.query('UPDATE shop_products SET quantity = 0 WHERE shop_id = $1', [shopId]);

  if (items.length) {
    // UPSERT: новые — вставятся (tracked возьмётся по DEFAULT TRUE),
    // существующие — обновятся по title/quantity, tracked останется как был.
    const values = [];
    const params = [];
    let p = 1;
    for (const it of items) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(shopId, it.sku, String(it.title || ''), Number(it.quantity || 0));
    }

    await db.query(
      `INSERT INTO shop_products (shop_id, sku, title, quantity)
       VALUES ${values.join(',')}
       ON CONFLICT (shop_id, sku) DO UPDATE
         SET title = EXCLUDED.title,
             quantity = EXCLUDED.quantity`,
      params
    );
  }

  await db.query('COMMIT');
}

module.exports = {
  // базовые
  getUserByChat,
  getShopsByChat,
  getShopById,

  // товары / tracked
  getShopProductsPage,
  toggleTracked,

  // себестоимость
  getActiveTrackedPage,
  setNetForTracked,

  // магазины
  addShopWithSync,
  deleteShopDeep,

  // обновление товаров:
  refreshShopProductsFromOzon,
};
