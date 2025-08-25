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

// ---------- товары магазина с «эффективным» tracked ----------
async function getShopProductsPage(db, shopId, page, pageSize) {
  const offset = (page - 1) * pageSize;

  const hc = await db.query(
    'SELECT COUNT(*)::int AS cnt FROM tracked_products WHERE shop_id = $1',
    [shopId]
  );
  const hasCustom = (hc.rows?.[0]?.cnt || 0) > 0;

  const totalRes = await db.query(
    'SELECT COUNT(*)::int AS c FROM shop_products WHERE shop_id = $1',
    [shopId]
  );
  const total = totalRes.rows?.[0]?.c || 0;

  const r = await db.query(
    `
    SELECT p.sku, p.title, p.quantity,
           COALESCE(tp.is_active, false) AS user_tracked
    FROM shop_products p
    LEFT JOIN tracked_products tp
      ON tp.shop_id = p.shop_id AND tp.sku = p.sku
    WHERE p.shop_id = $1
    ORDER BY p.title NULLS LAST, p.sku
    LIMIT $2 OFFSET $3
    `,
    [shopId, pageSize, offset]
  );

  const items = (r.rows || []).map(it => {
    const effective = hasCustom ? Boolean(it.user_tracked)
                                : (Number(it.quantity) || 0) > 0;
    return {
      sku: it.sku,
      title: it.title || `SKU ${it.sku}`,
      quantity: Number(it.quantity) || 0,
      tracked: effective,
    };
  });

  return { items, total, hasCustom };
}

// ---------- переключение отслеживания ----------
async function toggleTracked(db, shopId, sku) {
  await db.query(
    `
    INSERT INTO tracked_products (shop_id, sku, is_active, created_at, net)
    VALUES ($1, $2, true, NOW(), COALESCE((SELECT net FROM tracked_products WHERE shop_id=$1 AND sku=$2),0))
    ON CONFLICT (shop_id, sku)
    DO UPDATE SET is_active = NOT tracked_products.is_active
    `,
    [shopId, sku]
  );
}

// ---------- список активных tracked для экрана «Себестоимость товаров» ----------
async function getActiveTrackedPage(db, chatId, shopId, page, pageSize) {
  const offset = (page - 1) * pageSize;

  const base = `
    FROM tracked_products tp
    JOIN shops s         ON s.id = tp.shop_id
    JOIN shop_products p ON p.shop_id = tp.shop_id AND p.sku = tp.sku
    WHERE s.chat_id = $1 AND s.id = $2 AND tp.is_active = true
  `;

  const total = (await db.query(`SELECT COUNT(*)::int AS c ${base}`, [chatId, shopId]))
    .rows?.[0]?.c || 0;

  const items = (await db.query(
    `
    SELECT tp.shop_id, tp.sku, COALESCE(tp.net,0)::int AS net, p.title
    ${base}
    ORDER BY p.title NULLS LAST, tp.sku
    LIMIT $3 OFFSET $4
    `,
    [chatId, shopId, pageSize, offset]
  )).rows;

  return { items, total };
}

// ---------- установка себестоимости (net) ----------
async function setNetForTracked(db, chatId, shopId, sku, net) {
  // проверим, что магазин принадлежит пользователю
  const own = await db.query(
    'SELECT 1 FROM shops WHERE id=$1 AND chat_id=$2 LIMIT 1',
    [shopId, chatId]
  );
  if (!own.rowCount) throw new Error('shop_not_found');

  await db.query(
    `
    INSERT INTO tracked_products (shop_id, sku, is_active, created_at, net)
    VALUES ($1, $2, true, NOW(), $3)
    ON CONFLICT (shop_id, sku) DO UPDATE SET net = EXCLUDED.net
    `,
    [shopId, sku, net]
  );
}

// ---------- добавление магазина с синхронизацией ассортимента ----------
async function addShopWithSync(db, chatId, { client_id, api_key, shop_name }) {
  // запретим дубликаты магазинов по (chat_id, client_id)
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

  // тянем остатки и заполняем shop_products
  try {
    const items = await fetchStocksPositiveBySku({ client_id, api_key });
    await db.query('DELETE FROM shop_products WHERE shop_id=$1', [shopId]);

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
  } catch (e) {
    console.error('[addShopWithSync] sync error:', e?.response?.data || e);
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
};
