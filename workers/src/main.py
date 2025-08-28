"""
Cloudflare Workers Python API for SSHSshje Dashboard
Note: This is a simplified version due to Workers limitations
"""

from js import Response, Headers, fetch
import json
import asyncio
from datetime import datetime

# Configuration
REMOTE_HOST = "45.159.230.42"

async def handle_request(request):
    """Main request handler for Cloudflare Workers"""
    
    # Parse request
    url = request.url
    method = request.method
    
    # CORS headers
    cors_headers = Headers.new({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Content-Type": "application/json"
    })
    
    # Handle CORS preflight
    if method == "OPTIONS":
        return Response.new("", {"status": 200, "headers": cors_headers})
    
    try:
        # Route handling
        if "/api/system" in url:
            data = await get_mock_system_data()
            return Response.new(json.dumps(data), {"status": 200, "headers": cors_headers})
            
        elif "/api/services" in url:
            data = await get_mock_services_data()
            return Response.new(json.dumps(data), {"status": 200, "headers": cors_headers})
            
        elif "/api/containers" in url:
            data = await get_mock_containers_data()
            return Response.new(json.dumps(data), {"status": 200, "headers": cors_headers})
            
        elif "/api/applications" in url:
            data = await get_applications_data()
            return Response.new(json.dumps(data), {"status": 200, "headers": cors_headers})
            
        elif "/api/security" in url:
            data = await get_mock_security_data()
            return Response.new(json.dumps(data), {"status": 200, "headers": cors_headers})
            
        elif "/api/diagnostics" in url:
            data = await get_mock_diagnostics_data()
            return Response.new(json.dumps(data), {"status": 200, "headers": cors_headers})
            
        elif "/api/history" in url:
            data = await get_mock_history_data()
            return Response.new(json.dumps(data), {"status": 200, "headers": cors_headers})
            
        else:
            return Response.new(json.dumps({"error": "Not found"}), {"status": 404, "headers": cors_headers})
            
    except Exception as e:
        error_response = {"error": str(e), "timestamp": datetime.now().isoformat()}
        return Response.new(json.dumps(error_response), {"status": 500, "headers": cors_headers})

async def get_mock_system_data():
    """Mock system data since direct SSH isn't available in Workers"""
    import random
    
    return {
        "cpu_usage": 15 + random.random() * 30,
        "memory": {
            "total": 16777216000,
            "available": 12000000000 + random.randint(-2000000000, 2000000000),
            "percent": 25 + random.random() * 30,
            "used": 4000000000 + random.randint(-1000000000, 1000000000),
            "free": 12000000000
        },
        "disk": {
            "/": {
                "total": 524288000000,
                "used": 200000000000 + random.randint(-50000000000, 50000000000),
                "free": 300000000000,
                "percent": 38 + random.random() * 10
            }
        },
        "load_average": {
            "load1": 0.5 + random.random(),
            "load5": 0.7 + random.random(),
            "load15": 0.9 + random.random()
        },
        "network": {
            "bytes_sent": 1048576000 + random.randint(0, 1000000),
            "bytes_recv": 2097152000 + random.randint(0, 1000000),
            "packets_sent": 1000000 + random.randint(0, 10000),
            "packets_recv": 1500000 + random.randint(0, 10000)
        },
        "timestamp": int(datetime.now().timestamp())
    }

async def get_mock_services_data():
    """Mock services data"""
    import random
    
    services = {
        "ssh": {"service": "ssh", "active": True, "enabled": True, "status": "running"},
        "nginx": {"service": "nginx", "active": True, "enabled": True, "status": "running"},
        "docker": {"service": "docker", "active": True, "enabled": True, "status": "running"},
        "postgresql": {"service": "postgresql", "active": True, "enabled": True, "status": "running"},
        "redis-server": {"service": "redis-server", "active": random.choice([True, False]), "enabled": True, "status": random.choice(["running", "stopped"])}
    }
    
    healthy_count = sum(1 for s in services.values() if s["status"] == "running")
    
    return {
        "healthy_count": healthy_count,
        "unhealthy_count": len(services) - healthy_count,
        "services": services
    }

async def get_mock_containers_data():
    """Mock containers data"""
    import random
    
    containers = [
        {"id": "da74c2adae9b", "name": "guacamole-web", "image": "guacamole/guacamole", "status": "Up 2 hours", "state": "running"},
        {"id": "8b3f4d2e1a7c", "name": "guacamole-guacd", "image": "guacamole/guacd", "status": "Up 2 hours", "state": "running"},
        {"id": "9c5e6f8a2b1d", "name": "guacamole-db", "image": "mariadb", "status": "Up 2 hours", "state": "running"},
        {"id": "78cfa619689a", "name": "minibrowser", "image": "minio/browser", "status": random.choice(["Created", "Up 1 hour"]), "state": random.choice(["exited", "running"])}
    ]
    
    running = sum(1 for c in containers if c["state"] == "running")
    
    return {
        "total": len(containers),
        "running": running,
        "stopped": len(containers) - running,
        "unhealthy": 0,
        "containers": containers
    }

async def get_applications_data():
    """Get applications data with real health checks"""
    applications = {
        'cbl_frontend': f'http://{REMOTE_HOST}:9001',
        'cbl_backend': f'http://{REMOTE_HOST}:8001/api/health', 
        'cbl_mobile': f'http://{REMOTE_HOST}:8081',
        'guacamole': f'http://{REMOTE_HOST}:8080/guacamole'
    }
    
    result = {"applications": {}}
    healthy_count = 0
    
    for name, url in applications.items():
        try:
            # Make HTTP request to check health
            response = await fetch(url, {"method": "GET", "signal": "abort_after_timeout"})
            is_healthy = 200 <= response.status < 400
            
            result["applications"][name] = {
                "name": name.replace('_', ' ').title(),
                "url": url,
                "healthy": is_healthy,
                "status_code": response.status,
                "response_time": 0.5,  # Mock response time
                "error": None
            }
            
            if is_healthy:
                healthy_count += 1
                
        except Exception as e:
            result["applications"][name] = {
                "name": name.replace('_', ' ').title(),
                "url": url,
                "healthy": False,
                "status_code": None,
                "response_time": None,
                "error": str(e)[:100]  # Truncate long errors
            }
    
    result["healthy_count"] = healthy_count
    result["unhealthy_count"] = len(applications) - healthy_count
    
    return result

async def get_mock_security_data():
    """Mock security data"""
    return {
        "firewall": {
            "enabled": True,
            "default_incoming": "deny",
            "default_outgoing": "allow",
            "rules": ["22/tcp ALLOW IN", "80/tcp ALLOW IN", "443/tcp ALLOW IN", "8080/tcp ALLOW IN"]
        },
        "active_sessions": [
            {"user": "root", "terminal": "pts/0", "login_time": "Dec 28 04:15", "ip": "192.168.1.100"},
            {"user": "cbl", "terminal": "pts/1", "login_time": "Dec 28 03:42", "ip": "192.168.1.101"}
        ],
        "failed_logins": {
            "total_failed": 23,
            "recent_attempts": [
                {"timestamp": "Dec 28 04:20", "success": False, "user": "admin", "ip": "203.0.113.5", "raw_line": "Failed password for admin from 203.0.113.5"},
                {"timestamp": "Dec 28 04:18", "success": False, "user": "root", "ip": "203.0.113.12", "raw_line": "Failed password for root from 203.0.113.12"}
            ],
            "top_attacking_ips": [["203.0.113.5", 8], ["203.0.113.12", 5], ["198.51.100.3", 3]],
            "top_targeted_users": [["admin", 12], ["root", 8], ["user", 3]]
        },
        "timestamp": int(datetime.now().timestamp())
    }

async def get_mock_diagnostics_data():
    """Mock diagnostics data"""
    import random
    
    issues = []
    if random.random() > 0.7:
        issues.append({
            "id": "disk_usage_001",
            "severity": "warning",
            "category": "system",
            "title": "Disk usage approaching threshold",
            "description": "Root partition is at 42% capacity",
            "resolution": "Clean temporary files and old logs",
            "can_auto_resolve": True
        })
    
    return {
        "timestamp": int(datetime.now().timestamp()),
        "issues": issues,
        "health_score": 85 + random.randint(-10, 10)
    }

async def get_mock_history_data():
    """Mock historical data"""
    import random
    
    base_time = int(datetime.now().timestamp())
    metrics = []
    
    for i in range(50):
        metrics.append({
            "timestamp": base_time - (i * 300),
            "cpu_usage": 30 + random.random() * 40,
            "memory_usage": 40 + random.random() * 30,
            "disk_usage": 30 + random.random() * 15,
            "load_average": 0.5 + random.random() * 1.5
        })
    
    return {
        "metrics": list(reversed(metrics)),
        "alerts": [
            {"timestamp": base_time - 3600, "severity": "warning", "category": "system", "message": "High CPU usage detected", "resolved": True}
        ],
        "service_events": [
            {"timestamp": base_time - 1800, "service": "nginx", "event": "restarted", "details": "Automatic restart due to configuration change"}
        ]
    }

# Export the fetch event handler for Cloudflare Workers
async def on_fetch(request):
    return await handle_request(request)