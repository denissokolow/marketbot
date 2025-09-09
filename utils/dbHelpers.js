async function getTrackedSkusForUser(db, chatId, { stockOnly = false } = {}) {
  const stockClause = stockOnly ? 'AND sp.quantity > 0' : '';
  const sql = `
    SELECT DISTINCT
      regexp_replace(sp.sku::text, '\\s+', '', 'g')::bigint AS sku
    FROM shop_products sp
    JOIN shops s ON s.id = sp.shop_id
    WHERE s.chat_id = $1
      AND sp.tracked = TRUE
      ${stockClause}
  `;
  const res = await db.query(sql, [chatId]);
  const list = res.rows
    .map(r => Number(r.sku))
    .filter(n => Number.isFinite(n));

  console.log('[getTrackedSkusForUser]', { stockOnly, skus: list });
  return list;
}

module.exports = { getTrackedSkusForUser };
