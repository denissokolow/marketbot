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

async function getShopProductsPage(db, shopId, page = 1, pageSize = 10) {
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
    const effective = hasCustom ? Boolean(it.user_tracked) : (Number(it.quantity) || 0) > 0;
    return {
      sku: it.sku,
      title: it.title || `SKU ${it.sku}`,
      quantity: Number(it.quantity) || 0,
      tracked: effective,
    };
  });

  return { items, total, hasCustom };
}

async function toggleTracked(db, shopId, sku) {
  await db.query(
    `
    INSERT INTO tracked_products (shop_id, sku, is_active, net, created_at)
    VALUES ($1, $2, TRUE, 0, NOW())
    ON CONFLICT (shop_id, sku)
    DO UPDATE SET is_active = NOT tracked_products.is_active
    `,
    [shopId, sku]
  );
}

async function getActiveTrackedPage(db, chatId, page = 1, pageSize = 10) {
  const offset = (page - 1) * pageSize;

  const countRes = await db.query(
    `
    SELECT COUNT(*)::int AS c
    FROM tracked_products tp
    JOIN shops s ON s.id = tp.shop_id
    LEFT JOIN shop_products p ON p.shop_id = tp.shop_id AND p.sku = tp.sku
    WHERE s.chat_id = $1
      AND tp.is_active = TRUE
    `,
    [chatId]
  );
  const total = countRes.rows?.[0]?.c || 0;

  const r = await db.query(
    `
    SELECT tp.shop_id,
           s.name AS shop_name,
           tp.sku,
           COALESCE(p.title, 'SKU ' || tp.sku::text) AS title,
           COALESCE(tp.net, 0)::int AS net
    FROM tracked_products tp
    JOIN shops s ON s.id = tp.shop_id
    LEFT JOIN shop_products p ON p.shop_id = tp.shop_id AND p.sku = tp.sku
    WHERE s.chat_id = $1
      AND tp.is_active = TRUE
    ORDER BY s.name NULLS LAST, tp.sku
    LIMIT $2 OFFSET $3
    `,
    [chatId, pageSize, offset]
  );

  return { items: r.rows || [], total };
}

async function setNetForTracked(db, chatId, shopId, sku, net) {
  const s = await db.query('SELECT 1 FROM shops WHERE id = $1 AND chat_id = $2', [shopId, chatId]);
  if (!s.rowCount) throw new Error('shop_not_found');

  await db.query(
    `
    INSERT INTO tracked_products (shop_id, sku, is_active, net, created_at)
    VALUES ($1, $2, TRUE, $3, NOW())
    ON CONFLICT (shop_id, sku)
    DO UPDATE SET net = EXCLUDED.net
    `,
    [shopId, sku, net]
  );
}

module.exports = {
  getUserByChat,
  getShopsByChat,
  getShopById,
  getShopProductsPage,
  toggleTracked,
  getActiveTrackedPage,
  setNetForTracked,
};
