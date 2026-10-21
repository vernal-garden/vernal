module.exports = {
  apps: [
    {
      name: 'vernal',
      script: 'dist/index.js',
      node_args: '--enable-source-maps',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        // bcrypt hashes run on the libuv pool; the default of 4 lets a few
        // logins stall other async crypto and file work.
        UV_THREADPOOL_SIZE: 8,
      },
      error_file: '/var/log/pm2/vernal-error.log',
      out_file: '/var/log/pm2/vernal-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
