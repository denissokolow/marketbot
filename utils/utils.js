function getYesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}
function getTodayISO() {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}
module.exports = { getYesterdayISO, getTodayISO };



