const { Pool } = require('pg');
const { config } = require('./config');

let pool;
if (config.db.url) {
  // вариант с DATABASE_URL=postgres://...
  pool = new Pool({ connectionString: config.db.url, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 2000 });
} else {
  // вариант с DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
  pool = new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
}

module.exports = { pool };
