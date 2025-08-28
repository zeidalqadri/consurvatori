/**
 * Cloudflare Workers API for SSHSshje Dashboard
 * JavaScript implementation with better Workers support
 */

const REMOTE_HOST = "45.159.230.42";

export default {
  async fetch(request, env, ctx) {
    return await handleRequest(request, env);
  },
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    let data;
    
    if (path.includes('/api/system')) {
      data = await getMockSystemData();
    } else if (path.includes('/api/services')) {
      data = await getMockServicesData();
    } else if (path.includes('/api/containers')) {
      data = await getMockContainersData();
    } else if (path.includes('/api/applications')) {
      data = await getApplicationsData();
    } else if (path.includes('/api/security')) {
      data = await getMockSecurityData();
    } else if (path.includes('/api/diagnostics')) {
      data = await getMockDiagnosticsData();
    } else if (path.includes('/api/history')) {
      data = await getMockHistoryData();
    } else {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: corsHeaders,
    });
    
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: error.message,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

async function getMockSystemData() {
  return {
    cpu_usage: 15 + Math.random() * 30,
    memory: {
      total: 16777216000,
      available: 12000000000 + Math.floor(Math.random() * 4000000000 - 2000000000),
      percent: 25 + Math.random() * 30,
      used: 4000000000 + Math.floor(Math.random() * 2000000000 - 1000000000),
      free: 12000000000
    },
    disk: {
      "/": {
        total: 524288000000,
        used: 200000000000 + Math.floor(Math.random() * 100000000000 - 50000000000),
        free: 300000000000,
        percent: 38 + Math.random() * 10
      }
    },
    load_average: {
      load1: 0.5 + Math.random(),
      load5: 0.7 + Math.random(),
      load15: 0.9 + Math.random()
    },
    network: {
      bytes_sent: 1048576000 + Math.floor(Math.random() * 1000000),
      bytes_recv: 2097152000 + Math.floor(Math.random() * 1000000),
      packets_sent: 1000000 + Math.floor(Math.random() * 10000),
      packets_recv: 1500000 + Math.floor(Math.random() * 10000)
    },
    timestamp: Math.floor(Date.now() / 1000)
  };
}

async function getMockServicesData() {
  const services = {
    ssh: { service: "ssh", active: true, enabled: true, status: "running" },
    nginx: { service: "nginx", active: true, enabled: true, status: "running" },
    docker: { service: "docker", active: true, enabled: true, status: "running" },
    postgresql: { service: "postgresql", active: true, enabled: true, status: "running" },
    "redis-server": { 
      service: "redis-server", 
      active: Math.random() > 0.3, 
      enabled: true, 
      status: Math.random() > 0.3 ? "running" : "stopped" 
    }
  };
  
  const healthyCount = Object.values(services).filter(s => s.status === "running").length;
  
  return {
    healthy_count: healthyCount,
    unhealthy_count: Object.keys(services).length - healthyCount,
    services
  };
}

async function getMockContainersData() {
  const containers = [
    { id: "da74c2adae9b", name: "guacamole-web", image: "guacamole/guacamole", status: "Up 2 hours", state: "running" },
    { id: "8b3f4d2e1a7c", name: "guacamole-guacd", image: "guacamole/guacd", status: "Up 2 hours", state: "running" },
    { id: "9c5e6f8a2b1d", name: "guacamole-db", image: "mariadb", status: "Up 2 hours", state: "running" },
    { id: "78cfa619689a", name: "minibrowser", image: "minio/browser", status: Math.random() > 0.5 ? "Created" : "Up 1 hour", state: Math.random() > 0.5 ? "exited" : "running" }
  ];
  
  const running = containers.filter(c => c.state === "running").length;
  
  return {
    total: containers.length,
    running,
    stopped: containers.length - running,
    unhealthy: 0,
    containers
  };
}

async function getApplicationsData() {
  const applications = {
    'cbl_frontend': `http://${REMOTE_HOST}:9001`,
    'cbl_backend': `http://${REMOTE_HOST}:8001/api/health`,
    'cbl_mobile': `http://${REMOTE_HOST}:8081`,
    'guacamole': `http://${REMOTE_HOST}:8080/guacamole`
  };
  
  const result = { applications: {} };
  let healthyCount = 0;
  
  for (const [name, url] of Object.entries(applications)) {
    try {
      // Make HTTP request with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(url, { 
        signal: controller.signal,
        method: 'GET'
      });
      
      clearTimeout(timeoutId);
      const isHealthy = response.status >= 200 && response.status < 400;
      
      result.applications[name] = {
        name: name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        url,
        healthy: isHealthy,
        status_code: response.status,
        response_time: 0.5,
        error: null
      };
      
      if (isHealthy) healthyCount++;
      
    } catch (error) {
      result.applications[name] = {
        name: name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        url,
        healthy: false,
        status_code: null,
        response_time: null,
        error: error.message.substring(0, 100)
      };
    }
  }
  
  result.healthy_count = healthyCount;
  result.unhealthy_count = Object.keys(applications).length - healthyCount;
  
  return result;
}

async function getMockSecurityData() {
  return {
    firewall: {
      enabled: true,
      default_incoming: "deny",
      default_outgoing: "allow",
      rules: ["22/tcp ALLOW IN", "80/tcp ALLOW IN", "443/tcp ALLOW IN", "8080/tcp ALLOW IN"]
    },
    active_sessions: [
      { user: "root", terminal: "pts/0", login_time: "Dec 28 04:15", ip: "192.168.1.100" },
      { user: "cbl", terminal: "pts/1", login_time: "Dec 28 03:42", ip: "192.168.1.101" }
    ],
    failed_logins: {
      total_failed: 23,
      recent_attempts: [
        { timestamp: "Dec 28 04:20", success: false, user: "admin", ip: "203.0.113.5", raw_line: "Failed password for admin from 203.0.113.5" },
        { timestamp: "Dec 28 04:18", success: false, user: "root", ip: "203.0.113.12", raw_line: "Failed password for root from 203.0.113.12" }
      ],
      top_attacking_ips: [["203.0.113.5", 8], ["203.0.113.12", 5], ["198.51.100.3", 3]],
      top_targeted_users: [["admin", 12], ["root", 8], ["user", 3]]
    },
    timestamp: Math.floor(Date.now() / 1000)
  };
}

async function getMockDiagnosticsData() {
  const issues = [];
  if (Math.random() > 0.7) {
    issues.push({
      id: "disk_usage_001",
      severity: "warning",
      category: "system",
      title: "Disk usage approaching threshold",
      description: "Root partition is at 42% capacity",
      resolution: "Clean temporary files and old logs",
      can_auto_resolve: true
    });
  }
  
  return {
    timestamp: Math.floor(Date.now() / 1000),
    issues,
    health_score: 85 + Math.floor(Math.random() * 20 - 10)
  };
}

async function getMockHistoryData() {
  const baseTime = Math.floor(Date.now() / 1000);
  const metrics = [];
  
  for (let i = 0; i < 50; i++) {
    metrics.push({
      timestamp: baseTime - (i * 300),
      cpu_usage: 30 + Math.random() * 40,
      memory_usage: 40 + Math.random() * 30,
      disk_usage: 30 + Math.random() * 15,
      load_average: 0.5 + Math.random() * 1.5
    });
  }
  
  return {
    metrics: metrics.reverse(),
    alerts: [
      { timestamp: baseTime - 3600, severity: "warning", category: "system", message: "High CPU usage detected", resolved: true }
    ],
    service_events: [
      { timestamp: baseTime - 1800, service: "nginx", event: "restarted", details: "Automatic restart due to configuration change" }
    ]
  };
}