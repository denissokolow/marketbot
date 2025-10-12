// src/charts/lastM.js
'use strict';

const QuickChart = require('quickchart-js');

/** Helpers */
const firstWord = (s = '') => {
  const t = String(s).trim();
  if (!t) return '';
  const m = t.match(/^[^,|–—-]+/);
  return (m ? m[0] : t).trim();
};
const fmtMoney0 = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU');

/** Размер полотна и отступы */
const CANVAS_W = 1500;
const CANVAS_H = 1000;
const PAD_LEFT = 24;
const PAD_BOTTOM = 24;
// делаем область графика ≈ 1/3 полотна по ширине
const CHART_AREA_W = Math.round(CANVAS_W / 3);
const PAD_RIGHT = Math.max(0, CANVAS_W - PAD_LEFT - CHART_AREA_W); // ~ 1500 - 24 - 500 = 976
const PAD_TOP = 16;

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

/**
 * Данные для доната: топ-10 SKU по прибыли (>0)
 * Легенда берёт текст из labels => "Название (SKU) — 95 763₽"
 */
function buildDonutTop10(items) {
  const norm = (items || [])
    .map((it) => ({
      sku: String(it.sku ?? '').trim(),
      title: String(it.title ?? '').trim(),
      profit: Number(it.profit ?? 0),
    }))
    .filter((x) => x.sku && x.title && Number.isFinite(x.profit))
    .sort((a, b) => b.profit - a.profit)
    .filter((x) => x.profit > 0)
    .slice(0, 10);

  const labels = norm.map((x) =>
    `${firstWord(x.title)} (${x.sku}) — ${fmtMoney0(x.profit)}₽`
  );
  const data = norm.map((x) => x.profit);
  const colors = norm.map((_, i) => PALETTE[i % PALETTE.length]);

  return { labels, data, colors };
}

/**
 * Рендер: полотно 1500x1000, слева область графика ≈ 1/3 ширины.
 * Порядок сверху вниз: Заголовок, Легенда, Бублик.
 * В сообщении НИЧЕГО не выводим (никаких подписей/капшенов).
 * @param {{ bot:any, chatId:number|string, items:Array }} params
 */
async function sendLastMCharts({ bot, chatId, items }) {
  const { labels, data, colors } = buildDonutTop10(items || []);

  if (!data.length) {
    await bot.sendMessage(chatId, 'Нет данных для построения диаграммы (прибыль не найдена).');
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
      // Область графика сужаем до 1/3 полотна за счёт правого паддинга
      layout: { padding: { top: PAD_TOP, right: PAD_RIGHT, bottom: PAD_BOTTOM, left: PAD_LEFT } },
      cutout: '62%',
      plugins: {
        // Заголовок (над легендой)
        title: {
          display: true,
          text: 'Топ-10 SKU по прибыли',
          align: 'start',
          padding: { top: 4, bottom: 8 },
          font: { size: 24, weight: '600' },
          color: '#111',
        },
        // Встроенная легенда (над бубликом)
        legend: {
          display: true,
          position: 'top',
          align: 'start',
          labels: {
            boxWidth: 14,
            boxHeight: 14,
            padding: 12,
            font: { size: 16 },
            color: '#222',
          },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${fmtMoney0(Number(ctx.parsed) || 0)}₽`,
          },
        },
        datalabels: { display: false }, // никаких подписей на сегментах
      },
    },
  };

  qc.setConfig(config);
  const bin = await qc.toBinary();

  // Отправляем БЕЗ подписи/текста
  await bot.sendPhoto(
    chatId,
    { source: bin, filename: `profit_donut_${Date.now()}.png` }
  );
}

module.exports = { sendLastMCharts };
