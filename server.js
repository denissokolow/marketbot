const express = require('express');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_, res) => res.send('SellerBoss Telegram Bot is running'));

app.listen(PORT, () => {
  console.log(`Сервер на http://localhost:${PORT}`);
});
