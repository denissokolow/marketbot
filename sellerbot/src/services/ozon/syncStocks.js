// src/services/ozon/syncStocks.js
const { ozonApiRequest, request: ozonRequest } = require('./api');

const DEBUG_STOCKS = process.env.DEBUG_STOCKS === '1';
const dlog = (...a) => { if (DEBUG_STOCKS) console.log('[stocks]', ...a); };
const ilog = (...a) => console.log('[settings]', ...a);
const wlog = (...a) => console.warn('[settings]', ...a);
const elog = (...a) => console.error('[settings]', ...a);

function fmtPgErr(e) {
  if (!e) return { message: 'unknown error' };
  return {
    code: e.code,
    message: e.message,
    detail: e.detail,
    column: e.column,
    constraint: e.constraint,
    table: e.table,
    schema: e.schema,
    where: e.where,
    stack: (e.stack || '').split('\n').slice(0, 3).join(' | ')
  };
}

/** Унифицированный вызов OZON API */
async function callOzon({ client_id, api_key, endpoint, body }) {
  const fn = ozonApiRequest || ozonRequest;
  if (!fn) throw new Error('ozon api requester not found');
  return fn({ client_id, api_key, endpoint, body });
}

/** Последний магазин пользователя (по chat_id) */
async function getShopCredsByChat(pool, chatId) {
  const sql = `
    SELECT s.id, s.name, s.ozon_client_id, s.ozon_api_key
      FROM shops s
      JOIN users u ON u.id = s.user_id
     WHERE u.chat_id = $1
     ORDER BY s.created_at DESC, s.id DESC
     LIMIT 1`;
  const r = await pool.query(sql, [chatId]);
  return r.rows[0] || null;
}

/**
 * Тянем остатки через /v1/analytics/manage/stocks
 * Пагинация: {limit: 100, offset}, до пустого ответа.
 * Возвращает "сырой" массив items из API.
 */
async function fetchAllStocksManage({ client_id, api_key }) {
  const all = [];
  let offset = 0;
  const limit = 100;

  for (;;) {
    const body = { limit, offset };
    dlog('fetch page', body);
    let resp;
    try {
      resp = await callOzon({
        client_id, api_key,
        endpoint: '/v1/analytics/manage/stocks',
        body
      });
    } catch (e) {
      elog('fetch error', fmtPgErr(e), e?.response?.data || '');
      throw e;
    }
    const items = resp?.items || resp?.result?.items || [];
    dlog('page received', { count: items.length, sample: items.slice(0, 3) });

    if (!Array.isArray(items) || items.length === 0) break;
    all.push(...items);

    if (items.length < limit) break;
    offset += limit;
  }
  return all;
}

/**
 * Агрегируем по SKU (сумма по всем складам):
 * quantity = sum(valid_stock_count) для данного sku
 */
function aggregateStocksBySku(items) {
  const map = new Map(); // key=skuText -> { sku:Number, title:String, quantity:Number }
  for (const it of items) {
    const skuNum = Number(it?.sku) || 0;
    if (!skuNum) continue;
    const skuText = String(skuNum);
    const add = Number(it?.valid_stock_count ?? 0) || 0;
    if (add <= 0) continue;

    const title = (it?.name || it?.title || '').trim();
    const cur = map.get(skuText) || { sku: skuNum, title: '', quantity: 0 };
    cur.quantity += add;
    if (!cur.title && title) cur.title = title;
    map.set(skuText, cur);
  }
  const arr = [...map.values()];
  dlog('aggregated', { uniqueSkus: arr.length, sample: arr.slice(0, 4) });
  return arr;
}

/**
 * UPDATE → если 0 строк, пробуем INSERT.
 * Если INSERT упал из-за NOT NULL по id — делаем fallback с (MAX(id)+1).
 * sku сравниваем как текст (совместимо с длинными числами OZON).
 */
async function upsertOne(pool, { shopId, sku, title, qty }) {
  const skuText = String(sku);
  // 1) UPDATE
  try {
    const upd = await pool.query(
      `UPDATE shop_products
          SET title = COALESCE($3, title),
              quantity = $4
        WHERE shop_id = $1 AND sku::text = $2::text`,
      [shopId, skuText, title || null, qty]
    );
    if (upd.rowCount > 0) return { action: 'update' };
  } catch (e) {
    elog('update failed', { shopId, sku: skuText, qty }, fmtPgErr(e));
  }

  // 2) INSERT (обычный)
  try {
    const ins = await pool.query(
      `INSERT INTO shop_products (shop_id, sku, title, quantity, net)
       VALUES ($1, $2, $3, $4, 0)`,
      [shopId, skuText, title || '', qty]
    );
    return { action: 'insert', rowCount: ins.rowCount };
  } catch (e1) {
    const fe = fmtPgErr(e1);
    elog('insert failed', { shopId, sku: skuText, qty }, fe);

    // 2a) если проблема с id (NOT NULL / нет default) — fallback c явным id
    const idProblem =
      fe.code === '23502' /* not_null_violation */ ||
      /null value in column "id"/i.test(fe.message || '') ||
      /violates not-null constraint/i.test(fe.detail || '');

    if (idProblem) {
      try {
        const idRow = await pool.query(
          `SELECT COALESCE(MAX(id) + 1, 1) AS new_id FROM shop_products`
        );
        const newId = Number(idRow.rows[0]?.new_id || 1);
        const ins2 = await pool.query(
          `INSERT INTO shop_products (id, shop_id, sku, title, quantity, net)
           VALUES ($1, $2, $3, $4, $5, 0)`,
          [newId, shopId, skuText, title || '', qty]
        );
        ilog('insert fallback with explicit id', { shopId, sku: skuText, newId });
        return { action: 'insert_fallback', rowCount: ins2.rowCount };
      } catch (e2) {
        elog('insert fallback failed', { shopId, sku: skuText, qty }, fmtPgErr(e2));
        throw e2;
      }
    }

    // 2b) уникальный конфликт → повторим UPDATE
    const uniqueViolation = fe.code === '23505';
    if (uniqueViolation) {
      try {
        const upd2 = await pool.query(
          `UPDATE shop_products
              SET title = COALESCE($3, title),
                  quantity = $4
            WHERE shop_id = $1 AND sku::text = $2::text`,
          [shopId, skuText, title || null, qty]
        );
        if (upd2.rowCount > 0) {
          ilog('update after conflict', { shopId, sku: skuText, qty });
          return { action: 'update_after_conflict' };
        }
      } catch (e3) {
        elog('update after conflict failed', { shopId, sku: skuText, qty }, fmtPgErr(e3));
        throw e3;
      }
    }

    // иначе — отдаём ошибку наверх
    throw e1;
  }
}

/** Синк остатков по пользователю */
async function syncStocksForUser(pool, chatId, logger) {
  ilog('[settings] syncStocksForUser: start', { chatId });

  const shop = await getShopCredsByChat(pool, chatId);
  if (!shop) {
    wlog('[settings] no shop for chat', { chatId });
    return { ok: false, reason: 'no_shop' };
  }
  const { id: shopId, ozon_client_id: client_id, ozon_api_key: api_key, name } = shop;

  // 1) Тянем все строки по новому API
  const apiItems = await fetchAllStocksManage({ client_id, api_key });

  // 2) Агрегируем по SKU: сумма valid_stock_count
  const aggregated = aggregateStocksBySku(apiItems);

  // 3) Нормализуем и фильтруем qty>0
  const normalized = aggregated.map(x => ({
    sku: x.sku,
    title: x.title,
    quantity: Number(x.quantity) || 0,
  }));
  const withQty = normalized.filter(p => p.quantity > 0);

  ilog('[settings] pulled from api', {
    shop: name,
    raw: apiItems.length,
    uniqueSkus: aggregated.length,
    withQty: withQty.length
  });

  // 4) UPSERT в БД
  let updated = 0, inserted = 0, fallback = 0, errors = 0;
  for (const p of withQty) {
    try {
      const res = await upsertOne(pool, {
        shopId,
        sku: p.sku,
        title: p.title,
        qty: p.quantity,
      });
      if (res?.action === 'update' || res?.action === 'update_after_conflict') updated += 1;
      else if (res?.action === 'insert') inserted += 1;
      else if (res?.action === 'insert_fallback') { inserted += 1; fallback += 1; }
    } catch (e) {
      errors += 1;
      console.error('[settings] upsert failed', JSON.stringify({
        shopId, sku: String(p.sku), qty: p.quantity, err: fmtPgErr(e)
      }));
    }
  }

  // 5) Контроль, что позиции появились
  const check = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE quantity > 0)::int AS with_qty,
            COUNT(*)::int AS total
       FROM shop_products
      WHERE shop_id = $1`, [shopId]
  );

  const out = {
    ok: true,
    shopId,
    inserted,
    updated,
    fallbackUsed: fallback,
    errors,
    dbTotal: check.rows[0]?.total ?? 0,
    dbWithQty: check.rows[0]?.with_qty ?? 0,
  };
  ilog('[settings] syncStocksForUser: done', out);
  return out;
}

module.exports = { syncStocksForUser };
