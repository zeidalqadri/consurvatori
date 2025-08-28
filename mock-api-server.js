const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// Mock data generators
const generateSystemData = () => ({
  cpu_usage: 45 + Math.random() * 30,
  memory: {
    total: 16777216000,
    available: 8388608000,
    percent: 45 + Math.random() * 25,
    used: 7549747200,
    free: 8388608000
  },
  disk: {
    "/": {
      total: 524288000000,
      used: 167772160000,
      free: 356515840000,
      percent: 32 + Math.random() * 10
    }
  },
  load_average: {
    load1: 0.5 + Math.random() * 1.5,
    load5: 0.7 + Math.random() * 1.3,
    load15: 0.9 + Math.random() * 1.1
  },
  network: {
    bytes_sent: 1048576000,
    bytes_recv: 2097152000,
    packets_sent: 1000000,
    packets_recv: 1500000
  },
  timestamp: Math.floor(Date.now() / 1000)
});

const generateServicesData = () => ({
  healthy_count: 4,
  unhealthy_count: 1,
  services: {
    ssh: { service: 'ssh', active: true, enabled: true, status: 'running' },
    nginx: { service: 'nginx', active: true, enabled: true, status: 'running' },
    docker: { service: 'docker', active: true, enabled: true, status: 'running' },
    postgresql: { service: 'postgresql', active: true, enabled: true, status: 'running' },
    'redis-server': { service: 'redis-server', active: false, enabled: true, status: 'stopped' }
  }
});

const generateContainersData = () => ({
  total: 4,
  running: 3,
  stopped: 1,
  unhealthy: 0,
  containers: [
    { id: 'da74c2adae9b', name: 'guacamole-web', image: 'guacamole/guacamole', status: 'Up 2 hours', state: 'running' },
    { id: '8b3f4d2e1a7c', name: 'guacamole-guacd', image: 'guacamole/guacd', status: 'Up 2 hours', state: 'running' },
    { id: '9c5e6f8a2b1d', name: 'guacamole-db', image: 'mariadb', status: 'Up 2 hours', state: 'running' },
    { id: '78cfa619689a', name: 'minibrowser', image: 'minio/browser', status: 'Created', state: 'exited' }
  ]
});

const generateApplicationsData = () => ({
  healthy_count: 3,
  unhealthy_count: 1,
  applications: {
    cbl_frontend: { name: 'CBL Frontend', url: 'http://localhost:9001', healthy: true, status_code: 200, response_time: 0.45, error: null },
    cbl_backend: { name: 'CBL Backend', url: 'http://localhost:8001/api/health', healthy: true, status_code: 200, response_time: 0.23, error: null },
    cbl_mobile: { name: 'CBL Mobile', url: 'http://localhost:8081', healthy: true, status_code: 200, response_time: 0.67, error: null },
    guacamole: { name: 'Guacamole Web', url: 'http://localhost:8080/guacamole', healthy: false, status_code: null, response_time: null, error: 'Connection timeout' }
  }
});

const generateSecurityData = () => ({
  firewall: { enabled: true, default_incoming: 'deny', default_outgoing: 'allow', rules: ['22/tcp ALLOW IN', '80/tcp ALLOW IN', '443/tcp ALLOW IN', '8080/tcp ALLOW IN'] },
  active_sessions: [
    { user: 'root', terminal: 'pts/0', login_time: 'Aug 28 04:15', ip: '192.168.1.100' },
    { user: 'cbl', terminal: 'pts/1', login_time: 'Aug 28 03:42', ip: '192.168.1.101' }
  ],
  failed_logins: {
    total_failed: 23,
    recent_attempts: [
      { timestamp: 'Aug 28 04:20', success: false, user: 'admin', ip: '203.0.113.5', raw_line: 'Aug 28 04:20:15 server sshd[1234]: Failed password for admin from 203.0.113.5 port 4567 ssh2' },
      { timestamp: 'Aug 28 04:18', success: false, user: 'root', ip: '203.0.113.12', raw_line: 'Aug 28 04:18:45 server sshd[1233]: Failed password for root from 203.0.113.12 port 4567 ssh2' }
    ],
    top_attacking_ips: [['203.0.113.5', 8], ['203.0.113.12', 5], ['198.51.100.3', 3]],
    top_targeted_users: [['admin', 12], ['root', 8], ['user', 3]]
  },
  timestamp: Math.floor(Date.now() / 1000)
});

const generateDiagnosticsData = () => ({
  timestamp: Math.floor(Date.now() / 1000),
  issues: [
    { id: 'disk_usage_001', severity: 'warning', category: 'system', title: 'Disk usage approaching threshold', description: 'Root partition is at 42% capacity', resolution: 'Clean temporary files and old logs', can_auto_resolve: true },
    { id: 'service_redis_002', severity: 'critical', category: 'service', title: 'Redis service stopped', description: 'Redis server is not running', resolution: 'Restart redis-server service', can_auto_resolve: true }
  ],
  health_score: 78
});

const generateHistoryData = () => ({
  metrics: Array.from({length: 50}, (_, i) => ({
    timestamp: Math.floor(Date.now() / 1000) - (i * 300),
    cpu_usage: 30 + Math.random() * 40,
    memory_usage: 40 + Math.random() * 30,
    disk_usage: 30 + Math.random() * 15,
    load_average: 0.5 + Math.random() * 1.5
  })).reverse(),
  alerts: [
    { timestamp: Math.floor(Date.now() / 1000) - 3600, severity: 'warning', category: 'system', message: 'High CPU usage detected', resolved: true },
    { timestamp: Math.floor(Date.now() / 1000) - 7200, severity: 'critical', category: 'service', message: 'Redis service failed', resolved: true }
  ],
  service_events: [
    { timestamp: Math.floor(Date.now() / 1000) - 1800, service: 'nginx', event: 'restarted', details: 'Automatic restart due to configuration change' },
    { timestamp: Math.floor(Date.now() / 1000) - 3600, service: 'redis-server', event: 'failed', details: 'Service crashed unexpectedly' }
  ]
});

// API Routes
app.get('/api/system', (req, res) => res.json(generateSystemData()));
app.get('/api/services', (req, res) => res.json(generateServicesData()));
app.get('/api/containers', (req, res) => res.json(generateContainersData()));
app.get('/api/applications', (req, res) => res.json(generateApplicationsData()));
app.get('/api/security', (req, res) => res.json(generateSecurityData()));
app.get('/api/diagnostics', (req, res) => res.json(generateDiagnosticsData()));
app.get('/api/history', (req, res) => res.json(generateHistoryData()));

// Action endpoints
app.post('/api/actions/restart', (req, res) => {
  const { type, name } = req.body;
  console.log(`Restart ${type}: ${name}`);
  res.json({ success: true, message: `${type} ${name} restarted successfully` });
});

app.post('/api/actions/resolve', (req, res) => {
  const { issue_id } = req.body;
  console.log(`Resolve issue: ${issue_id}`);
  res.json({ success: true, message: `Issue ${issue_id} resolved`, actions_taken: ['Service restarted', 'Configuration validated'] });
});

// WebSocket for real-time updates
wss.on('connection', (ws) => {
  console.log('Dashboard connected via WebSocket');
  
  const sendSystemUpdate = () => {
    ws.send(JSON.stringify({
      type: 'system_update',
      payload: generateSystemData()
    }));
  };
  
  // Send initial data
  sendSystemUpdate();
  
  // Send updates every 30 seconds
  const interval = setInterval(sendSystemUpdate, 30000);
  
  // Send occasional alerts
  const alertInterval = setInterval(() => {
    if (Math.random() > 0.7) {
      ws.send(JSON.stringify({
        type: 'alert',
        payload: {
          severity: 'info',
          title: 'System Update',
          message: 'Routine monitoring check completed'
        }
      }));
    }
  }, 60000);
  
  ws.on('close', () => {
    console.log('Dashboard disconnected');
    clearInterval(interval);
    clearInterval(alertInterval);
  });
});

const PORT = process.env.API_PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 SSHSshje Mock API Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}`);
  console.log('');
  console.log('Available endpoints:');
  console.log('  GET  /api/system');
  console.log('  GET  /api/services');
  console.log('  GET  /api/containers');
  console.log('  GET  /api/applications');
  console.log('  GET  /api/security');
  console.log('  GET  /api/diagnostics');
  console.log('  GET  /api/history');
  console.log('  POST /api/actions/restart');
  console.log('  POST /api/actions/resolve');
});