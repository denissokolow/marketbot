// services/ozon/reporting.js
const { post } = require('./api');

// Пример: создать отчёт (подставьте ваш фактический endpoint и payload)
async function createReport(payload, opts) {
  // TODO: заменить путь/тело на ваши (например: '/v1/report/create')
  return post('/v1/report/create', payload, opts);
}

// Пример: узнать статус/результат отчёта
async function getReportStatus(payload, opts) {
  // TODO: заменить на ваш endpoint (например: '/v1/report/info')
  return post('/v1/report/info', payload, opts);
}

// Универсальный «поллер»: ждёт, пока отчёт будет готов.
// isReady(response) должен вернуть true, когда ответ готов.
async function waitForReport({ getStatus, isReady, intervalMs = 1500, timeoutMs = 120000 }) {
  const started = Date.now();
  // Первый вызов
  let resp = await getStatus();
  while (!isReady(resp)) {
    if (Date.now() - started > timeoutMs) {
      const err = new Error('Ozon report timeout');
      err.lastResponse = resp;
      throw err;
    }
    await new Promise(r => setTimeout(r, intervalMs));
    resp = await getStatus();
  }
  return resp;
}

/**
 * Пример «всё-в-одном»: запросить отчёт и дождаться результата.
 * @param {object} create - { payload, opts }
 * @param {function} isReady - функция, которая по ответу getReportStatus понимает, что всё готово
 * @param {function} makeStatusPayload - функция, генерирующая payload для getReportStatus (например по report_id)
 */
async function createAndWait({ create, isReady, makeStatusPayload, intervalMs, timeoutMs }) {
  const createResp = await createReport(create.payload, create.opts);

  // TODO: получите идентификатор отчёта из createResp (например: const reportId = createResp.result.report_id)
  const reportId = createResp?.result?.report_id; // скорректируйте под свою схему

  const getStatus = () => getReportStatus(makeStatusPayload(reportId), create.opts);
  return waitForReport({ getStatus, isReady, intervalMs, timeoutMs });
}

module.exports = {
  createReport,
  getReportStatus,
  waitForReport,
  createAndWait,
};
