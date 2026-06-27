// PM2 Ecosystem Config – keeps the backend alive 24/7 on Oracle Cloud
// Usage:  pm2 start ecosystem.config.cjs
//         pm2 save
//         pm2 startup   ← run the printed command to survive reboots
module.exports = {
  apps: [
    {
      name: "insightflow-backend",
      script: "server.js",
      cwd: "/home/ubuntu/insightflow/backend",   // ← change to your actual path
      interpreter: "node",
      node_args: "--experimental-vm-modules",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "400M",
      env: {
        NODE_ENV: "production",
        PORT: 3001,
      },
      // Log rotation (keeps disk usage low)
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "/home/ubuntu/insightflow/logs/backend-out.log",
      error_file: "/home/ubuntu/insightflow/logs/backend-err.log",
      merge_logs: true,
    },
  ],
};
