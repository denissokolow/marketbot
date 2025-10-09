// src/charts/lastM.js
// Рисуем 2 картинки для /lastM через QuickChart (без нативных либ):
//   - Топ-N выручка по SKU (bar)
//   - Затраты vs Прибыль по SKU (bar, может быть отрицательная прибыль)

const QuickChart = require('quickchart-js');

// аккуратный срез названия до «первого серьёзного разделителя»
function firstWord(s='') {
  const t = String(s).trim();
  if (!t) return '';
  const m = t.match(/^[^,|–—-]+/);
  return (m ? m[0] : t).trim();
}

function labelForItem(it) {
  const base = firstWord(it.title) || `SKU ${it.sku}`;
  return `${base} (${it.sku})`;
}

function topN(items, field, n) {
  return [...items].sort((a,b) => (Number(b[field]||0)-Number(a[field]||0))).slice(0, n);
}

async function sendChart({ bot, chatId, config, caption, width=1000, height=600, bg='white' }) {
  const qc = new QuickChart();
  qc.setConfig(config);
  qc.setWidth(width);
  qc.setHeight(height);
  qc.setBackgroundColor(bg);

  // Можно qc.getUrl(), но короче — shortUrl
  const url = await qc.getShortUrl();
  await bot.sendPhoto(chatId, { url }, { caption, parse_mode: 'HTML' });
}

async function sendLastMCharts({ bot, chatId, items, period }) {
  if (!Array.isArray(items) || items.length === 0) return;

  const N = Number(process.env.LASTM_CHART_TOPN || 10);

  // 1) Топ-N по выручке
  const topRevenue = topN(items, 'revenue', N);
  const labels1 = topRevenue.map(labelForItem);
  const revenueData = topRevenue.map(x => Math.round(Number(x.revenue||0)));
  const spendData   = topRevenue.map(x => Math.round(Number(x.ad_spend||0)));

  const chart1 = {
    type: 'bar',
    data: {
      labels: labels1,
      datasets: [
        { label: 'Выручка', data: revenueData },
        { label: 'Расходы (реклама)', data: spendData },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'top' },
        title: {
          display: true,
          text: `Топ-${labels1.length} по выручке • ${period}`,
        },
      },
      scales: {
        x: { ticks: { maxRotation: 60, minRotation: 0 } },
        y: { beginAtZero: true },
      },
    },
  };

  await sendChart({ bot, chatId, config: chart1 });

  // 2) Затраты vs Прибыль (по тем же SKU)
  const profitData = topRevenue.map(x => Math.round(Number(x.profit || 0)));

  const chart2 = {
    type: 'bar',
    data: {
      labels: labels1,
      datasets: [
        { label: 'Расходы (реклама)', data: spendData },
        { label: 'Прибыль', data: profitData },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'top' },
        title: {
          display: true,
          text: `Затраты vs Прибыль • ${period}`,
        },
      },
      scales: {
        x: { ticks: { maxRotation: 60, minRotation: 0 } },
        y: { beginAtZero: true },
      },
    },
  };

  await sendChart({ bot, chatId, config: chart2 });
}

module.exports = { sendLastMCharts };
