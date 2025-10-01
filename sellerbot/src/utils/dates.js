function getYesterdayISO() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Текущий день в заданном часовом поясе (по умолчанию из .env)
function todayRangeISO(tz = process.env.TZ || 'Europe/Moscow') {
  // Переводим "сейчас" в локальное время нужного пояса:
  const nowTz = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const start = new Date(nowTz);
  start.setHours(0, 0, 0, 0);       // начало дня в этом поясе
  const end = new Date(start);
  end.setDate(end.getDate() + 1);   // [start, end)

  // Возвращаем в ISO (UTC) — удобно для запросов к API/БД
  return { start: start.toISOString(), end: end.toISOString() };
}

module.exports = { getYesterdayISO, todayRangeISO };
