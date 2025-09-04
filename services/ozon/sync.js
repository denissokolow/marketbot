// services/ozon/sync.js
const { fetchStocksPositiveBySku } = require('./analytics');

/**
 * Синхронизирует tracked_products с текущими "товарами с >0 остатком" из Ozon.
 * Не меняет is_active, только добавляет новые SKU и обновляет title.
 * Возвращает список для отображения в меню: [{ sku, title, quantity, is_active }]
 */
async function syncTrackedFromOzonAndBuildList({ db, chatId, client_id, api_key }) {
  // 1) получаем список позитивных остатков с Ozon
  const stocks = await fetchStocksPositiveBySku({ client_id, api_key }); // [{sku, title, quantity}]

  // 2) узнаем shop_id
  const shopRow = await db.query('SELECT id FROM shops WHERE chat_id = $1', [chatId]);
  if (!shopRow.rows.length) throw new Error('Shop not found for given chatId');
  const shopId = shopRow.rows[0].id;

  // 3) гарантируем уникальный ключ (shop_id, sku) — если у вас уже есть, этот шаг можно опустить
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
          AND indexname = 'uq_tracked_products_shop_sku'
      ) THEN
        CREATE UNIQUE INDEX uq_tracked_products_shop_sku ON tracked_products(shop_id, sku);
      END IF;
    END$$;
  `);

  // 4) (опционально) колонка title — если у вас её нет, можно удалить обновление title ниже
  await db.query(`ALTER TABLE tracked_products ADD COLUMN IF NOT EXISTS title text;`);

  // 5) upsert новых SKU пачками (по 1000)
  const chunk = 1000;
  for (let i = 0; i < stocks.length; i += chunk) {
    const part = stocks.slice(i, i + chunk);
    // VALUES: (shop_id, sku, title, is_active)
    const values = [];
    const params = [];
    let p = 1;
    for (const it of part) {
      values.push(`($${p++}, $${p++}, $${p++}, FALSE)`);
      params.push(shopId, Number(it.sku), String(it.title || ''));
    }

    // Требуется уникальный индекс (shop_id, sku), см. п.3
    const sql = `
      INSERT INTO tracked_products (shop_id, sku, title, is_active)
      VALUES ${values.join(', ')}
      ON CONFLICT (shop_id, sku) DO UPDATE
        SET title = EXCLUDED.title
    `;
    await db.query(sql, params);
  }

  // 6) вернуть список для меню: только те, что сейчас с положительным остатком
  //      (обогащаем is_active из БД)
  // Передадим массив sku в виде bigint[]
  const skuArr = stocks.map(x => Number(x.sku)).filter(Number.isFinite);
  if (!skuArr.length) return []; // нечего показывать

  // создаём временный массив через UNNEST
  const listSql = `
    WITH stock AS (
      SELECT UNNEST($1::bigint[]) AS sku
    )
    SELECT tp.sku::bigint      AS sku,
           COALESCE(tp.title,'') AS title,
           tp.is_active          AS is_active
    FROM stock s
    JOIN tracked_products tp
      ON tp.shop_id = $2 AND tp.sku = s.sku
    ORDER BY tp.sku
  `;
  const listRows = await db.query(listSql, [skuArr, shopId]);

  // слепим quantity из того, что пришло с Ozon (по sku)
  const qtyMap = new Map(stocks.map(x => [Number(x.sku), Number(x.quantity || 0)]));
  const out = listRows.rows.map(r => ({
    sku: Number(r.sku),
    title: r.title,
    is_active: !!r.is_active,
    quantity: qtyMap.get(Number(r.sku)) || 0,
  }));

  return out;
}

module.exports = { syncTrackedFromOzonAndBuildList };
