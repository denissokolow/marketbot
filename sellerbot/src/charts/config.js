// src/charts/config.js
function num(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

module.exports = {
  WIDTH:        num('CHART_WIDTH', 1200),
  HEIGHT:       num('CHART_HEIGHT', 700),
  DPI:          num('CHART_DPI', 144),
  BACKGROUND:   process.env.CHART_BG || '#ffffff',

  FONT_FAMILY:  process.env.CHART_FONT_FAMILY || 'Inter, Arial, Roboto, "Segoe UI", sans-serif',
  FONT_SIZE:    num('CHART_FONT_SIZE', 16),
  GRID_COLOR:   process.env.CHART_GRID_COLOR || 'rgba(0,0,0,0.08)',

  COLOR_ORDERS:   process.env.COLOR_ORDERS   || '#1E88E5', // синий — Заказы
  COLOR_BUYOUT:   process.env.COLOR_BUYOUT   || '#43A047', // зелёный — Выкуп
  COLOR_EXPENSES: process.env.COLOR_EXPENSES || '#E53935', // красный — Расходы
  COLOR_PROFIT:   process.env.COLOR_PROFIT   || '#FB8C00', // оранжевый — Прибыль

  // опционально: путь к .ttf, если хотите свой шрифт (например /usr/share/fonts/…/Inter.ttf)
  FONT_TTF:     process.env.CHART_FONT_TTF || '',
};
