// utils/dbHelpers.js
async function getTrackedSkusForUser(db, chatId) {
  const sql = `
    SELECT DISTINCT
      regexp_replace(tp.sku::text, '\\s+', '', 'g')::bigint AS sku
    FROM tracked_products tp
    JOIN shops s ON s.id = tp.shop_id
    WHERE s.chat_id = $1
      AND tp.is_active = TRUE
  `;
  const res = await db.query(sql, [chatId]);
  const list = res.rows
    .map(r => Number(r.sku))
    .filter(n => Number.isFinite(n));

  console.log('[getTrackedSkusForUser] active SKUs:', list);
  return list; // массив чисел
}

module.exports = { getTrackedSkusForUser };



