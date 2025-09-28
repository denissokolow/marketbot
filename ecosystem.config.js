module.exports = {
  apps: [{
    name: 'sellerboss-bot',
    script: 'bot.js',
    node_args: '--unhandled-rejections=strict',  // падать на unhandledRejection
    env: {
      NODE_ENV: 'production',
    },
    time: true,                 // метка времени в логах
    autorestart: true,          // перезапуск при выходе
    min_uptime: '10s',          // считать запуск успешным если прожил 10с
    max_restarts: 20,           // не бесконечно
    restart_delay: 5000,        // пауза между рестартами
    exp_backoff_restart_delay: 100, // экспоненциальная пауза на частых крэшах
    max_memory_restart: '512M', // рестарт при утечках памяти
    watch: false                // включайте только если понимаете последствия
  }]
}
