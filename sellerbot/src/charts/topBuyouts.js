// src/charts/topBuyouts.js
'use strict';

const QuickChart = require('quickchart-js');

/** Helpers */
const firstWord = (s = '') => {
  const t = String(s).trim();
  if (!t) return '';
  const m = t.match(/^[^,|–—-]+/);
  return (m ? m[0] : t).trim();
};
const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU');
const toNumberSafe = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string') {
    const clean = v.replace(/[^\d-]/g, '');
    if (!clean) return NaN;
    const n = Number(clean);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
};

/** Полотно */
const CANVAS_W = 1500;
const CANVAS_H = 1000;

/** Tableau 10 palette (НЕ МЕНЯТЬ) */
const PALETTE = [
  '#4e79a7', // blue
  '#f28e2b', // orange
  '#e15759', // red
  '#76b7b2', // teal
  '#59a14f', // green
  '#edc948', // yellow
  '#b07aa1', // purple
  '#ff9da7', // pink
  '#9c755f', // brown
  '#bab0ab', // gray
];

/** Берём количество выкупов (шт.) из разных возможных полей */
function getUnits(it) {
  const keys = [
    // основные
    'buyout_units', 'buyouts', 'buyoutsCount', 'buyoutCount',
    // алиасы
    'purchased', 'purchased_count', 'purchasedCount', 'purchasedQty', 'purchasedUnits',
    'sold', 'sold_count', 'soldUnits',
    'units', 'qty', 'quantity',
    'delivered', 'delivered_count', 'deliveredUnits',
    'units_buyout', 'buyouts_units', 'buyoutQty', 'buyout_quantity', 'purchases', 'purchases_count',
  ];
  for (const k of keys) {
    if (k in (it || {})) {
      const n = toNumberSafe(it[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return NaN;
}

/** Готовим топ-10 по количеству выкупов (>0) */
function buildDonutTop10ByUnits(items) {
  const norm = (items || [])
    .map((it) => ({
      sku: String(it?.sku ?? '').trim(),
      title: String(it?.title ?? '').trim(),
      units: getUnits(it),
    }))
    .filter((x) => x.sku && x.title && Number.isFinite(x.units) && x.units > 0)
    .sort((a, b) => b.units - a.units)
    .slice(0, 10);

  const labels = norm.map((x) => `${firstWord(x.title)} (${x.sku}) — ${fmtInt(x.units)} шт.`);
  const data   = norm.map((x) => x.units);
  const colors = norm.map((_, i) => PALETTE[i % PALETTE.length]);

  return { labels, data, colors };
}

/**
 * Рендер бублика «Топ-10 SKU по выкупам» по центру полотна 1500×1000.
 * Заголовок (центр) → легенда (центр) → бублик (центр).
 * В сообщении НИЧЕГО не выводим.
 * @param {{ bot:any, chatId:number|string, items:Array }} params
 */
async function sendTopBuyoutsChart({ bot, chatId, items }) {
  const { labels, data, colors } = buildDonutTop10ByUnits(items || []);

  if (!data.length) {
    await bot.sendMessage(chatId, 'Нет данных для построения диаграммы (выкупы не найдены).');
    return;
  }

  const qc = new QuickChart();
  qc.setWidth(CANVAS_W);
  qc.setHeight(CANVAS_H);
  qc.setBackgroundColor('white');
  qc.setFormat('png');
  if (typeof qc.setVersion === 'function') qc.setVersion('4'); // Chart.js v4

  const config = {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderColor: 'white',
        borderWidth: 2,
        hoverOffset: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 16, right: 24, bottom: 24, left: 24 } },
      cutout: '62%',
      plugins: {
        // Заголовок по центру
        title: {
          display: true,
          text: 'Топ-10 SKU по выкупам',
          align: 'center',
          padding: { top: 4, bottom: 8 },
          font: { size: 24, weight: '600' },
          color: '#111',
        },
        // Легенда по центру (берёт текст из labels)
        legend: {
          display: true,
          position: 'top',
          align: 'center',
          labels: {
            boxWidth: 14,
            boxHeight: 14,
            padding: 12,
            font: { size: 16 },
            color: '#222',
          },
        },
        // Подсказки: показываем «123 шт.»
        tooltip: {
          callbacks: {
            label: (ctx) => `${fmtInt(Number(ctx.parsed) || 0)} шт.`,
          },
        },
        // Никаких подписей на сегментах
        datalabels: { display: false },
      },
    },
  };

  qc.setConfig(config);
  const bin = await qc.toBinary();

  // Отправляем без подписи/текста
  await bot.sendPhoto(
    chatId,
    { source: bin, filename: `buyouts_donut_${Date.now()}.png` }
  );
}

module.exports = { sendTopBuyoutsChart };
