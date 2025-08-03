const { Markup } = require('telegraf');
function getMainMenu() {
  return Markup.keyboard([
    ['🔄 Прислать статус сейчас', '📅 Прислать за вчера'],
    ['📩 Подписаться на рассылку', '🔕 Отписаться от рассылки']
  ]).resize();
}
module.exports = { getMainMenu };