// return_logistics_probe.js
// Тест: стоимость логистики возврата по данным Ozon Seller API.
// Запуск: node return_logistics_probe.js [YYYY-MM-DD]
// Опц. фильтр по SKU: OZON_FILTER_SKUS="123,456,789" node return_logistics_probe.js 2025-09-03

const axios = require('axios');

// === НАСТРОЙКИ ===
const CLIENT_ID = process.env.OZON_CLIENT_ID || '1332514';
const API_KEY   = process.env.OZON_API_KEY   || '90f55b56-d6b9-4ade-8414-701afbe56ad8';

// Необязательный фильтр по SKU (через env OZON_FILTER_SKUS="123,456")
const FILTER_SKUS = (process.env.OZON_FILTER_SKUS || '')
  .split(',')
  .map(s => Number(String(s).trim()))
  .filter(n => Number.isFinite(n));
const useSkuFilter = FILTER_SKUS.length > 0;

// Дата отчёта: аргумент CLI или вчера по UTC
const argDate = process.argv[2];
const date = argDate || getYesterdayISO();
const from = `${date}T00:00:00.000Z`;
const to   = `${date}T23:59:59.999Z`;

// === УТИЛЫ ===
function getYesterdayISO() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const fmtRub = n => (Math.round(Number(n) || 0)).toLocaleString('ru-RU') + '₽';

// POST к Seller API
async function ozonPost(endpoint, body) {
  const url = `https://api-seller.ozon.ru${endpoint}`;
  const headers = {
    'Client-Id': CLIENT_ID,
    'Api-Key': API_KEY,
    'Content-Type': 'application/json',
  };
  const res = await axios.post(url, body, { headers, timeout: 20000 });
  return res.data;
}

// Хелперы фильтрации
const isReturnishOp = (op) => {
  const t = String(op?.type || '').toLowerCase();             // иногда 'returns'/'orders'
  const name = String(op?.operation_type_name || '').toLowerCase();
  return t.includes('return') || name.includes('возврат');
};
const isReturnLogisticsService = (s) => {
  const n = String(s?.name || s?.type || '').toLowerCase();
  // покрываем "логистика возврата", "обработка возврата", "обратная логистика"
  return (n.includes('возврат') && (n.includes('логист') || n.includes('обработ')));
};
const hasTracked = (items, skuSet) => {
  if (!skuSet) return true;
  if (!Array.isArray(items) || !items.length) return false;
  for (const it of items) {
    const sku = Number(it?.sku);
    if (skuSet.has(sku)) return true;
  }
  return false;
};

// === ОСНОВНАЯ ЛОГИКА ===
(async () => {
  if (!CLIENT_ID || !API_KEY || CLIENT_ID.includes('PASTE_') || API_KEY.includes('PASTE_')) {
    console.error('❌ Заполни CLIENT_ID и API_KEY (или задай OZON_CLIENT_ID / OZON_API_KEY).');
    process.exit(1);
  }

  const skuSet = useSkuFilter ? new Set(FILTER_SKUS) : null;
  console.log('===== OZON Return Logistics Probe =====');
  console.log('Дата:', date);
  console.log('Client-Id:', CLIENT_ID);
  if (useSkuFilter) console.log('Фильтр SKU:', FILTER_SKUS.join(', '));
  console.log('---------------------------------------\n');

  // 1) totals — для контекста
  const totals = await ozonPost('/v3/finance/transaction/totals', {
    date: { from, to },
    posting_number: '',
    transaction_type: 'all',
  }).then(d => d?.result || {}).catch(e => {
    console.error('totals error:', e?.response?.data || e.message);
    return {};
  });

  // 2) постранично ходим в list и собираем метрики по "логистике возврата"
  let page = 1;
  const page_size = 1000;

  let matchedOps = 0;
  let totalReturnLogistics = 0; // обычно отрицательная сумма (расход)
  const serviceBreakdown = new Map(); // name -> { sum, count }
  const opSamples = []; // примеры операций с совпадениями (для вывода)

  while (true) {
    const body = {
      filter: {
        date: { from, to },
        operation_type: [],
        posting_number: '',
        transaction_type: 'all',
      },
      page,
      page_size,
    };

    const data = await ozonPost('/v3/finance/transaction/list', body)
      .catch(e => {
        console.error('list error:', e?.response?.data || e.message);
        return null;
      });

    const ops = data?.result?.operations || [];
    if (!ops.length) break;

    for (const op of ops) {
      if (!isReturnishOp(op)) continue;

      const items = Array.isArray(op?.items) ? op.items : [];
      if (!hasTracked(items, skuSet)) continue;

      const services = Array.isArray(op?.services) ? op.services : [];
      const matchedServices = services.filter(isReturnLogisticsService);

      if (!matchedServices.length) continue;

      matchedOps += 1;

      let opSum = 0;
      for (const s of matchedServices) {
        const name = s?.name || s?.type || 'unknown';
        const amt = Number(s?.amount ?? 0);
        if (Number.isFinite(amt)) {
          opSum += amt;
          const cur = serviceBreakdown.get(name) || { sum: 0, count: 0 };
          cur.sum += amt;
          cur.count += 1;
          serviceBreakdown.set(name, cur);
        }
      }

      totalReturnLogistics += opSum;

      // сохраним до 10 примеров
      if (opSamples.length < 10) {
        opSamples.push({
          posting_number: op?.posting_number || '-',
          name: op?.operation_type_name || '-',
          accruals_for_sale: Number(op?.accruals_for_sale ?? 0),
          matchedSum: opSum,
          items: items.slice(0, 6).map(it => `${it?.sku}${it?.name ? ' ' + String(it.name).slice(0, 24) : ''}`),
          services: matchedServices.map(s => `${s?.name || s?.type}: ${fmtRub(s?.amount)}`),
        });
      }
    }

    if (ops.length < page_size) break;
    page += 1;
  }

  // 3) вывод результата
  console.log('ИТОГО ПО /v3/finance/transaction/totals за день:');
  console.log('  accruals_for_sale:       ', fmtRub(totals.accruals_for_sale || 0));
  console.log('  sale_commission:         ', fmtRub(totals.sale_commission || 0));
  console.log('  processing_and_delivery: ', fmtRub(totals.processing_and_delivery || 0));
  console.log('  refunds_and_cancellations:', fmtRub(totals.refunds_and_cancellations || 0));
  console.log('  services_amount:         ', fmtRub(totals.services_amount || 0));
  console.log('  compensation_amount:     ', fmtRub(totals.compensation_amount || 0));
  console.log('  money_transfer:          ', fmtRub(totals.money_transfer || 0));
  console.log('  others_amount:           ', fmtRub(totals.others_amount || 0));
  console.log('---------------------------------------');

  console.log(`Найдено операций возврата (с совпавшими сервисами): ${matchedOps}`);
  console.log(`Сумма логистики/обработки возврата: ${fmtRub(totalReturnLogistics)} (обычно отрицательно)\n`);

  if (serviceBreakdown.size) {
    console.log('Разбивка по названиям услуг:');
    for (const [name, agg] of serviceBreakdown.entries()) {
      console.log(`  • ${name}: ${fmtRub(agg.sum)}  (x${agg.count})`);
    }
    console.log('---------------------------------------');
  } else {
    console.log('Подходящих услуг логистики возврата не найдено.');
  }

  if (opSamples.length) {
    console.log('Примеры операций:');
    for (const op of opSamples) {
      console.log(' - - - - ');
      console.log(`  Операция: ${op.name}`);
      console.log(`  Отгрузка: ${op.posting_number}`);
      console.log(`  Начисления за продажу (op): ${fmtRub(op.accruals_for_sale)}`);
      console.log(`  Совпавшие услуги: ${op.services.join('; ') || '—'}`);
      console.log(`  Сумма по совпадениям в операции: ${fmtRub(op.matchedSum)}`);
      if (op.items?.length) console.log(`  Items: ${op.items.join(', ')}${op.items.length >= 6 ? ' …' : ''}`);
    }
    console.log(' - - - - ');
  }
})().catch(err => {
  console.error('Fatal error:', err?.response?.data || err);
  process.exit(1);
});
