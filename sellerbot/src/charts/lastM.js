// src/charts/lastM.js
'use strict';

const QuickChart = require('quickchart-js');

// ---------- helpers ----------
function firstWord(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  const m = t.match(/^[^,|–—-]+/);
  return (m ? m[0] : t).trim();
}
function fmtMoney0(n) { return Math.round(Number(n) || 0).toLocaleString('ru-RU'); }
function fmtInt(n)    { return Math.round(Number(n) || 0).toLocaleString('ru-RU'); }

// Tableau 10 (НЕ МЕНЯТЬ)
const PALETTE = [
  '#4E79A7','#F28E2B','#E15759','#76B7B2','#59A14F',
  '#EDC948','#B07AA1','#FF9DA7','#9C755F','#BAB0AC'
];

// ---------- прибыль: топ-10 ----------
function computeAbcByProfit(items) {
  const sorted = (items || [])
    .map(x => ({ sku: Number(x.sku), profit: Number(x.profit) || 0 }))
    .filter(x => Number.isFinite(x.sku))
    .sort((a,b)=> b.profit - a.profit);

  const totalPos = sorted.reduce((s,x)=> s + (x.profit > 0 ? x.profit : 0), 0);
  const out = new Map();
  if (totalPos <= 0) { for (const x of sorted) out.set(x.sku, 'C'); return out; }

  const A_LIMIT = Number(process.env.ABC_A_LIMIT || 0.80);
  let acc = 0;
  for (const x of sorted) {
    if (x.profit > 0) {
      acc += x.profit;
      out.set(x.sku, (acc/totalPos) <= A_LIMIT ? 'A' : 'B');
    } else out.set(x.sku, 'C');
  }
  return out;
}
function buildTopProfit(items) {
  const abc = computeAbcByProfit(items);
  const norm = (items || [])
    .map(it => ({
      sku: String(it?.sku ?? '').trim(),
      title: String(it?.title ?? '').trim(),
      profit: Number(it?.profit ?? 0),
      cls: abc.get(Number(it?.sku)) || 'C',
    }))
    .filter(x => x.sku && x.title && Number.isFinite(x.profit) && x.profit > 0)
    .sort((a,b)=> b.profit - a.profit);

  const A = norm.filter(x=>x.cls==='A');
  const B = norm.filter(x=>x.cls==='B');
  const C = norm.filter(x=>x.cls==='C');

  const top = [];
  top.push(...A);
  for (const x of B) { if (top.length >= 10) break; top.push(x); }
  for (const x of C) { if (top.length >= 10) break; top.push(x); }

  return {
    title: 'Топ-10 SKU по прибыли',
    labels: top.map(x => `${firstWord(x.title)} (${x.sku}) — ${fmtMoney0(x.profit)}₽`),
    values: top.map(x => x.profit),
    colors: top.map((_,i)=> PALETTE[i % PALETTE.length]),
  };
}

// ---------- выкупы: нормализация units ----------
function toNumberSafe(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^\d-]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
      const n = toNumberSafe(obj[k]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return NaN;
}
function getUnits(it) {
  const direct = pick(it, [
    'buyout_units','buyouts','buyoutsCount','buyoutCount',
    'purchased','purchased_count','purchasedCount','purchasedQty','purchasedUnits',
    'sold','sold_count','soldUnits','units','qty','quantity',
  ]);
  if (Number.isFinite(direct)) return direct;

  const byRevenue = pick(it, ['buyout_revenue','buyoutRevenue','revenue_buyout','buyouts_revenue']);
  const avgPrice  = pick(it, ['avg_price','avgPrice','price_avg','price']);
  if (Number.isFinite(byRevenue) && Number.isFinite(avgPrice) && avgPrice > 0) {
    return Math.max(1, Math.round(byRevenue / avgPrice));
  }

  const ordered = pick(it, ['ordered_units','orderedUnits','ordered','orders','ordered_count']);
  if (Number.isFinite(ordered)) return ordered;

  return NaN;
}
function buildTopBuyouts(items) {
  const norm = (items || [])
    .map(it => ({
      sku: String(it?.sku ?? '').trim(),
      title: String(it?.title ?? '').trim(),
      units: getUnits(it),
    }))
    .filter(x => x.sku && x.title && Number.isFinite(x.units) && x.units > 0)
    .sort((a,b)=> b.units - a.units)
    .slice(0, 10);

  return {
    title: 'Топ-10 SKU по выкупам',
    labels: norm.map(x => `${firstWord(x.title)} (${x.sku}) — ${fmtInt(x.units)} шт.`),
    values: norm.map(x => x.units),
    colors: norm.map((_,i)=> PALETTE[i % PALETTE.length]),
  };
}

// ---------- ABC-распределение по количеству SKU ----------
function classifyAbc(items) {
  const A_LIMIT = Number(process.env.ABC_A_LIMIT || 0.80);
  const B_LIMIT = Number(process.env.ABC_B_LIMIT || 0.95);

  const sorted = (items || [])
    .map(x => ({ sku: String(x?.sku ?? '').trim(), title: String(x?.title ?? '').trim(), profit: Number(x?.profit || 0) }))
    .filter(x => x.sku && x.title)
    .sort((a,b)=> b.profit - a.profit);

  const totalPos = sorted.reduce((s,x)=> s + (x.profit > 0 ? x.profit : 0), 0);
  const groups = { A: [], B: [], C: [] };

  if (totalPos <= 0) {
    for (const x of sorted) groups.C.push(x);
    return groups;
  }

  let acc = 0;
  for (const x of sorted) {
    if (x.profit > 0) {
      acc += x.profit;
      const share = acc / totalPos;
      if (share <= A_LIMIT) groups.A.push(x);
      else if (share <= B_LIMIT) groups.B.push(x);
      else groups.C.push(x);
    } else {
      groups.C.push(x);
    }
  }
  return groups;
}
function buildAbcDistribution(items) {
  const groups = classifyAbc(items);
  const counts = { A: groups.A.length, B: groups.B.length, C: groups.C.length };

  function listLine(letter, arr) {
    if (!arr.length) return `${letter} (0): —`;
    const maxShow = 8;
    const parts = arr.slice(0, maxShow).map(x => `${firstWord(x.title)} (${x.sku})`);
    const rest = arr.length - parts.length;
    if (rest > 0) parts.push(`+${rest}`);
    return `${letter} (${arr.length}): ${parts.join(' • ')}`;
  }

  return {
    title: 'ABC по прибыли — распределение SKU',
    labels: [`A — ${counts.A}`, `B — ${counts.B}`, `C — ${counts.C}`],
    values: [counts.A, counts.B, counts.C],
    colors: [PALETTE[0], PALETTE[1], PALETTE[2]],
    subtitleLines: [
      listLine('A', groups.A),
      listLine('B', groups.B),
      listLine('C', groups.C),
    ],
  };
}

// ---------- ТЕКСТОВАЯ КАРТОЧКА ----------
function buildSummaryText(items) {
  const toNum = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string') {
      const n = Number(v.replace(/[^\d\-]/g, ''));
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  };
  const sum = (arr, field) => (arr || []).reduce((s, it) => s + toNum(it?.[field]), 0);

  const orderedUnits   = sum(items, 'ordered_units');       // Заказано (шт.)
  const orderedRevenue = sum(items, 'revenue');             // Заказано на сумму
  const buyoutUnits    = sum(items, 'buyout_units');        // Выкуплено (шт.)
  const buyoutRevenue  = sum(items, 'buyout_revenue');      // Выкуплено на сумму
  const adSpend        = sum(items, 'ad_spend');            // Реклама
  const profitTotal    = sum(items, 'profit');              // Используем как "Маржа" (в рублях)

  // Д.Р.Р. = adSpend / (выкупная выручка || заказная выручка)
  let drrStr = '';
  const drrDen = buyoutRevenue > 0 ? buyoutRevenue : (orderedRevenue > 0 ? orderedRevenue : 0);
  if (adSpend > 0 && drrDen > 0) {
    const drr = (adSpend / drrDen) * 100;
    drrStr = drr.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
  }

  // Поля, которых нет — оставляем пустыми
  const cogsStr    = ''; // Себестоимость выкупов
  const returnsStr = ''; // Возвраты (шт.)
  const retSumStr  = ''; // Возвраты на сумму
  const ozonFeeStr = ''; // Комиссия OZON

  const money = (n) => (Math.round(n) || 0).toLocaleString('ru-RU') + '₽';
  const int   = (n) => (Math.round(n) || 0).toLocaleString('ru-RU');

  return {
    title: 'Итоги за период',
    // список слева: добавил иконки
    lines: [
      '📦 Заказано: ' + int(orderedUnits),
      '💳 Заказано на сумму: ' + money(orderedRevenue),
      '🛒 Выкуплено: ' + int(buyoutUnits),
      '💰 Выкуплено на сумму: ' + money(buyoutRevenue),
      '🧾 Себестоимость выкупов: ' + cogsStr,
      '🔁 Возвраты: ' + returnsStr,
      '💸 Возвраты на сумму: ' + retSumStr,
      '📢 Расходы на рекламу: ' + money(adSpend),
      '📊 Д.Р.Р.: ' + drrStr,
      '🏷️ Комиссия OZON: ' + ozonFeeStr,
      '💵 Маржа: ' + money(profitTotal),
    ],
  };
}


// ---------- фабрики конфигов (БЕЗ функций/колбеков) ----------
function makeDonutConfig({ title, labels, values, colors }) {
  const PAD_TOP = Number(process.env.LASTM_PAD_TOP || 60);
  return {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderColor: '#ffffff',
        borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      animation: false,
      layout: { padding: { top: PAD_TOP, left: 20, right: 20, bottom: 30 } },
      plugins: {
        title: {
          display: true,
          text: title,
          align: 'center',
          padding: { top: 6, bottom: 8 },
          font: { size: 22, weight: '600' },
          color: '#111',
        },
        legend: {
          display: true,
          position: 'top',
          align: 'center',
          labels: {
            boxWidth: 14,
            boxHeight: 14,
            padding: 10,
            font: { size: 14 },
            color: '#222',
          },
        },
        tooltip: { enabled: false },
        // крупные белые подписи в долях
        datalabels: {
          display: true,
          color: '#ffffff',
          anchor: 'center',
          align: 'center',
          clamp: true,
          font: { size: 18, weight: '700' }
        }
      },
    },
    plugins: ['chartjs-plugin-datalabels'],
  };
}
function makeAbcDonutConfig({ title, labels, values, colors, subtitleLines }) {
  const PAD_TOP_ABC = Number(process.env.LASTM_PAD_TOP_ABC || 82);
  return {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderColor: '#ffffff',
        borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      animation: false,
      layout: { padding: { top: PAD_TOP_ABC, left: 20, right: 20, bottom: 30 } },
      plugins: {
        title: {
          display: true,
          text: title,
          align: 'center',
          padding: { top: 6, bottom: 4 },
          font: { size: 22, weight: '600' },
          color: '#111',
        },
        subtitle: {
          display: true,
          text: Array.isArray(subtitleLines) ? subtitleLines : [String(subtitleLines || '')],
          align: 'center',
          padding: { top: 0, bottom: 8 },
          font: { size: 12, weight: '400' },
          color: '#374151',
        },
        legend: {
          display: true,
          position: 'top',
          align: 'center',
          labels: {
            boxWidth: 14,
            boxHeight: 14,
            padding: 10,
            font: { size: 14 },
            color: '#222',
          },
        },
        tooltip: { enabled: false },
        datalabels: {
          display: true,
          color: '#ffffff',
          anchor: 'center',
          align: 'center',
          clamp: true,
          font: { size: 18, weight: '700' }
        }
      },
    },
    plugins: ['chartjs-plugin-datalabels'],
  };
}
function makeTextCardConfig({ title, lines }) {
  const PAD_TOP_TXT = Number(process.env.LASTM_PAD_TOP_TXT || 40);
  return {
    type: 'bar',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: { x: { display: false }, y: { display: false } },
      layout: { padding: { top: PAD_TOP_TXT, left: 20, right: 20, bottom: 30 } },
      plugins: {
        // заголовок по центру
        title: {
          display: true,
          text: title,
          align: 'center',
          padding: { top: 10, bottom: 12 },
          font: { size: 22, weight: '600' },
          color: '#111',
        },
        // список по левому краю
        subtitle: {
          display: true,
          text: Array.isArray(lines) ? lines : [String(lines || '')],
          align: 'start',
          padding: { top: 6, bottom: 8 },
          font: { size: 16, weight: '500' },
          color: '#111',
        },
        legend: { display: false },
        tooltip: { enabled: false },
      },
    },
  };
}

// ---------- основной экспорт ----------
async function sendLastMCharts({ bot, chatId, items /*, period*/ }) {
  if (!Array.isArray(items) || items.length === 0) return;

  const left = buildTopProfit(items);
  if (!left.values.length) {
    await bot.sendMessage(chatId, 'Нет данных для построения диаграммы (прибыль не найдена).');
    return;
  }
  const mid = buildTopBuyouts(items);
  const haveMid = mid.values && mid.values.length > 0;

  const abc = buildAbcDistribution(items);
  const haveAbc = (abc.values || []).some(v => Number(v) > 0);

  const summary = buildSummaryText(items); // текстовая карточка

  const W = Number(process.env.LASTM_SINGLE_W || 1000);
  const H = Number(process.env.LASTM_SINGLE_H || 1000);

  // profit
  const qLeft = new QuickChart();
  if (typeof qLeft.setVersion === 'function') qLeft.setVersion('4');
  if (typeof qLeft.setDevicePixelRatio === 'function') qLeft.setDevicePixelRatio(2);
  qLeft.setConfig(makeDonutConfig(left));
  qLeft.setWidth(W); qLeft.setHeight(H);
  qLeft.setBackgroundColor('white'); qLeft.setFormat('png');
  const leftPng = await qLeft.toBinary();

  // buyouts (если есть)
  let midPng = null;
  if (haveMid) {
    const qMid = new QuickChart();
    if (typeof qMid.setVersion === 'function') qMid.setVersion('4');
    if (typeof qMid.setDevicePixelRatio === 'function') qMid.setDevicePixelRatio(2);
    qMid.setConfig(makeDonutConfig(mid));
    qMid.setWidth(W); qMid.setHeight(H);
    qMid.setBackgroundColor('white'); qMid.setFormat('png');
    midPng = await qMid.toBinary();
  }

  // ABC распределение (если есть)
  let abcPng = null;
  if (haveAbc) {
    const qAbc = new QuickChart();
    if (typeof qAbc.setVersion === 'function') qAbc.setVersion('4');
    if (typeof qAbc.setDevicePixelRatio === 'function') qAbc.setDevicePixelRatio(2);
    qAbc.setConfig(makeAbcDonutConfig(abc));
    qAbc.setWidth(W); qAbc.setHeight(H);
    qAbc.setBackgroundColor('white'); qAbc.setFormat('png');
    abcPng = await qAbc.toBinary();
  }

  // TEXT card
  const qTxt = new QuickChart();
  if (typeof qTxt.setVersion === 'function') qTxt.setVersion('4');
  if (typeof qTxt.setDevicePixelRatio === 'function') qTxt.setDevicePixelRatio(2);
  qTxt.setConfig(makeTextCardConfig(summary));
  qTxt.setWidth(W); qTxt.setHeight(H);
  qTxt.setBackgroundColor('white'); qTxt.setFormat('png');
  const txtPng = await qTxt.toBinary();

  // формируем медиа-группу
  const media = [];
  media.push({ type: 'photo', media: { source: leftPng, filename: `profit_${Date.now()}.png` } });
  if (midPng) media.push({ type: 'photo', media: { source: midPng,  filename: `buyouts_${Date.now()}.png` } });
  if (abcPng) media.push({ type: 'photo', media: { source: abcPng,  filename: `abc_${Date.now()}.png` } });
  media.push({ type: 'photo', media: { source: txtPng,  filename: `summary_${Date.now()}.png` } });

  if (media.length === 1) {
    await bot.sendPhoto(chatId, media[0].media);
    return;
  }

  await bot.sendMediaGroup(chatId, media);
}

module.exports = { sendLastMCharts };
