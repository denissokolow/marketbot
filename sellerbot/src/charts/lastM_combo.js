// src/charts/lastM_combo.js
'use strict';

const QuickChart = require('quickchart-js');

// ——— палитра (как у тебя) ———
const PALETTE = [
  '#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f',
  '#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ab'
];

const firstWord = (s='') => {
  const t = String(s).trim();
  if (!t) return '';
  const m = t.match(/^[^,|–—-]+/);
  return (m ? m[0] : t).trim();
};
const fmtMoney0 = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU');
const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU');

// ——— данные для левого бублика (прибыль) ———
function buildTopProfit(items) {
  const norm = (items || [])
    .map(it => ({
      sku: String(it?.sku ?? '').trim(),
      title: String(it?.title ?? '').trim(),
      profit: Number(it?.profit ?? 0),
    }))
    .filter(x => x.sku && x.title && Number.isFinite(x.profit) && x.profit > 0)
    .sort((a,b)=> b.profit - a.profit)
    .slice(0, 10);

  return {
    title: 'Топ-10 SKU по прибыли',
    labels: norm.map(x => `${firstWord(x.title)} (${x.sku}) — ${fmtMoney0(x.profit)}₽`),
    values: norm.map(x => x.profit),
    colors: norm.map((_,i)=> PALETTE[i % PALETTE.length]),
  };
}

// ——— аккуратный сбор выкупов ———
function toNumberSafe(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^\d-]/g,''));
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    const n = toNumberSafe(v);
    if (Number.isFinite(n) && n > 0) return n;
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

  const fallbackOrdered = pick(it, ['ordered_units','orderedUnits','ordered','orders','ordered_count']);
  if (Number.isFinite(fallbackOrdered)) return fallbackOrdered;

  return NaN;
}

// ——— данные для среднего бублика (выкупы) ———
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

// ——— единственный рендерер: оба бублика на одном полотне через кастомный плагин ———
async function sendLastMComboCharts({ bot, chatId, items }) {
  try {
    const left = buildTopProfit(items || []);
    const mid  = buildTopBuyouts(items || []);

    if (!left.values.length) {
      await bot.sendMessage(chatId, 'Нет данных для построения диаграммы (прибыль не найдена).');
      return false;
    }
    if (!mid.values.length) {
      await bot.sendMessage(chatId, 'Нет данных для построения диаграммы (выкупы не найдены).');
      return false;
    }

    // один canvas 1500x1000
    const W = Number(process.env.LASTM_COMBO_W || 1500);
    const H = Number(process.env.LASTM_COMBO_H || 1000);

    // Кастомный плагин: рисуем 2 бублика и их заголовки/легенды.
    // Никаких внешних зависимостей: только Chart.js API (ctx.*).
    const doubleDonutPlugin = {
      id: 'doubleDonut',
      beforeDraw(chart, args, opts) {
        const { ctx, width, height } = chart;
        if (!ctx) return;

        const sections = [
          { data: opts.left,  x0: 0,        x1: width/3 }, // левая треть
          { data: opts.mid,   x0: width/3,  x1: 2*width/3 }, // средняя треть
        ];

        const padX = 20;
        const padTop = 20;
        const titleH = 36;
        const legendLineH = 24;
        const legendGap = 8;
        const donutGapTop = 20;

        const fontTitle = '600 24px system-ui, -apple-system, Segoe UI, Roboto, Arial';
        const fontLegend = '16px system-ui, -apple-system, Segoe UI, Roboto, Arial';

        sections.forEach((sec) => {
          const s = sec.data || {};
          const x0 = Math.floor(sec.x0);
          const x1 = Math.floor(sec.x1);
          const innerW = Math.max(60, x1 - x0 - padX*2);
          const leftX = x0 + padX;

          // 1) Заголовок
          ctx.save();
          ctx.font = fontTitle;
          ctx.fillStyle = '#111';
          ctx.textBaseline = 'top';
          ctx.fillText(String(s.title || ''), leftX, padTop);
          ctx.restore();

          // 2) Легенда (вертикальный список)
          ctx.save();
          ctx.font = fontLegend;
          ctx.textBaseline = 'top';
          let yLegend = padTop + titleH + 4;
          const qty = Math.min(10, (s.labels || []).length);
          for (let i = 0; i < qty; i++) {
            const label = s.labels[i];
            const color = s.colors[i];

            // цветной квадратик
            ctx.fillStyle = color || '#888';
            ctx.fillRect(leftX, yLegend + 4, 12, 12);

            // подпись
            ctx.fillStyle = '#222';
            const textX = leftX + 18;
            const textY = yLegend;
            // обрезка текста по ширине колонки
            const maxW = innerW - 18;
            // простая обрезка с «…»
            let t = String(label || '');
            let measured = ctx.measureText(t).width;
            while (measured > maxW && t.length > 5) {
              t = t.slice(0, -2) + '…';
              measured = ctx.measureText(t).width;
            }
            ctx.fillText(t, textX, textY);

            yLegend += legendLineH;
          }
          ctx.restore();

          // 3) Бублик
          const sum = (s.values || []).reduce((acc, v) => acc + (Number(v) > 0 ? Number(v) : 0), 0);
          if (sum <= 0) return;

          const centerX = x0 + (x1 - x0)/2;
          // центр ниже легенды
          const centerY = Math.max(height * 0.58, yLegend + donutGapTop + 180);
          const outerR = Math.min((x1 - x0) * 0.28, height * 0.28);
          const innerR = outerR * 0.62;

          let angle = -Math.PI / 2; // старт сверху
          for (let i = 0; i < (s.values || []).length; i++) {
            const v = Number(s.values[i]) || 0;
            if (v <= 0) continue;
            const frac = v / sum;
            const a = frac * Math.PI * 2;

            const start = angle;
            const end = angle + a;

            // сектор
            ctx.beginPath();
            ctx.moveTo(centerX, centerY);
            ctx.arc(centerX, centerY, outerR, start, end);
            ctx.closePath();
            ctx.fillStyle = s.colors[i] || '#aaa';
            ctx.fill();

            // «дырка» (cutout)
            ctx.save();
            ctx.globalCompositeOperation = 'destination-out';
            ctx.beginPath();
            ctx.arc(centerX, centerY, innerR, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();

            angle = end;
          }

          // белая обводка между секторами (для аккуратности)
          ctx.save();
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#ffffff';
          angle = -Math.PI/2;
          for (let i = 0; i < (s.values || []).length; i++) {
            const v = Number(s.values[i]) || 0;
            if (v <= 0) continue;
            const frac = v / sum;
            const a = frac * Math.PI * 2;

            const start = angle;
            const end = angle + a;

            ctx.beginPath();
            ctx.arc(centerX, centerY, outerR, start, end);
            ctx.stroke();

            angle = end;
          }
          ctx.restore();
        });
      },
    };

    // Конфиг пустого «каркаса» (нам нужен чистый canvas и включённый наш плагин)
    const config = {
      type: 'bar',        // тип неважен, мы всё рисуем плагином
      data: { labels: [], datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: { x: { display:false }, y: { display:false } },
        plugins: { legend: { display:false }, tooltip: { enabled:false } },
      },
      plugins: [
        // наш плагин
        Object.assign({}, doubleDonutPlugin, { options: { left, mid } }),
      ],
    };

    const qc = new QuickChart();
    qc.setWidth(W);
    qc.setHeight(H);
    qc.setBackgroundColor('white');
    qc.setFormat('png');
    if (typeof qc.setVersion === 'function') qc.setVersion('4');
    qc.setConfig(config);

    const bin = await qc.toBinary();

    await bot.sendPhoto(
      chatId,
      { source: bin, filename: `lastm_combo_${Date.now()}.png` },
    );
    return true;
  } catch (e) {
    try { await bot.sendMessage(chatId, '⚠️ Не удалось собрать единое полотно графиков (без Jimp).'); } catch {}
    return false;
  }
}

module.exports = { sendLastMComboCharts };
