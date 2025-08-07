const { 
  getOzonReport, 
  getReturnsCount, 
  getReturnsSum, 
  getDeliveryBuyoutStats, 
  getBuyoutAndProfit, 
  formatMoney 
} = require('../ozon');
const { getTodayISO, getYesterdayISO } = require('./utils');

async function makeReportText(user, date) {
  // Даты для запроса
  const from = `${date}T00:00:00.000Z`;
  const to   = `${date}T23:59:59.999Z`;

  // 1. Метрики по заказам
  const metrics = await getOzonReport({
    client_id: user.client_id,
    api_key: user.seller_api,
    date,
    metrics: ['revenue', 'ordered_units']
  });

  // 2. Возвраты
  const returnsCount = await getReturnsCount({ client_id: user.client_id, api_key: user.seller_api, date });
  const returnsSum = await getReturnsSum({ client_id: user.client_id, api_key: user.seller_api, date });

  // 3. Выкупы (Доставка покупателю, количество, сумма, себестоимость)
  const stats = await getDeliveryBuyoutStats({
    client_id: user.client_id,
    api_key: user.seller_api,
    date_from: from,
    date_to: to
  });

  // 4. Итоговые суммы по выкупам и прибыли (по /v3/finance/transaction/totals)
  const { buyoutAmount, profit } = await getBuyoutAndProfit({
    client_id: user.client_id,
    api_key: user.seller_api,
    date_from: from,
    date_to: to,
    buyoutCost: stats.buyoutCost // Себестоимость обязательно!
  });

  // Функция для выравнивания
const pad = (str, len = 5) => {
  str = String(str);
  return ' '.repeat(Math.max(0, len - str.length)) + str;
};

  // Формируем отчет БЕЗ блока кода (голубой фон убирается)
  let result = '';
  result += `🏪 Магазин:${pad(user.shop_name || "Неизвестно")}\n`;
  result += `📆 Отчет за:${pad(date)}\n\n`;

  result += `📦 Заказано товаров:${pad(metrics?.[1] ?? '-',50)}\n`;
  result += `💸 Заказано на сумму:${pad(formatMoney(metrics?.[0]) + '₽',50)}\n\n`;

  result += `📦 Выкуплено товаров:${pad(stats.totalCount,50)}\n`;
  result += `💸 Выкуплено на сумму:${pad(formatMoney(buyoutAmount) + '₽',50)}\n`;
  result += `💸 Себестоимость выкупов:${pad(formatMoney(stats.buyoutCost) + '₽', 50)}\n`;
  result += `🟩 Прибыль:${pad(formatMoney(profit) + '₽', 50)}\n\n`;

  result += `📦 Возвраты:${pad(returnsCount, 50)}\n`;
  result += `💸 Возвраты на сумму:${pad(formatMoney(returnsSum) + '₽', 50)}\n\n`;

  return result;
}

async function makeTodayReportText(user) {
  const date = getTodayISO();
  return await makeReportText(user, date);
}

async function makeYesterdayReportText(user) {
  const date = getYesterdayISO();
  return await makeReportText(user, date);
}

module.exports = {
  makeTodayReportText,
  makeYesterdayReportText
};



