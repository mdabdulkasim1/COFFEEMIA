module.exports = {
  apps: [
    {
      name: "coffeemia-pos",
      script: "server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "development",
        PORT: 3100,
        TZ: "Asia/Kolkata"
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 3100,
        TZ: "Asia/Kolkata"
      }
    }
  ]
};
