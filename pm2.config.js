// pm2 process configuration for the Raspberry Pi stream server.
//
//   pm2 start pm2.config.js     # start (run from the repo root on the Pi)
//   pm2 save                    # remember it across reboots
//   pm2 startup                 # print the command to enable boot startup
//
// Networking note:
//   The Pi's internal LAN address is 192.168.0.186:2638. The server binds to
//   0.0.0.0 (all interfaces) so it is reachable both on the LAN and, via a
//   port-forward on your router (104.229.7.78:2638 -> 192.168.0.186:2638),
//   from the public internet. LAN_IP below is informational and is reported
//   on /health; change HOST to 192.168.0.186 only if you want to restrict the
//   server to the LAN interface.

module.exports = {
  apps: [
    {
      name: 'pi-stream-server',
      script: 'server.js',
      cwd: './pi-server',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0', // bind all interfaces (keeps it externally reachable)
        PORT: 2638, // listen port (forwarded from the public IP)
        LAN_IP: '192.168.0.186', // Pi's internal IP (reference / health output)
        VIDEO_DEVICE: '/dev/video0',
        FRAMERATE: '15',
        RESOLUTION: '1280x720',
        QUALITY: '5',
        // INPUT_FORMAT: 'mjpeg', // uncomment if the camera outputs MJPEG natively
        // COPY: '1',             // ...and this to stream without re-encoding (low CPU)
      },
    },
  ],
};
