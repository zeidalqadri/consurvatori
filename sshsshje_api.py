#!/usr/bin/env python3
"""
SSHSshje API Backend
Real-time monitoring API for CBL Basketball Platform
Connects to remote sshsshje agent via SSH
"""

import asyncio
import json
import time
import logging
from datetime import datetime
from typing import Dict, Any, List, Optional
from contextlib import asynccontextmanager

import paramiko
import psutil
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, BackgroundTasks, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import os
from dotenv import load_dotenv
import secrets
import hashlib

# Load environment variables
load_dotenv()
import subprocess


# Configuration
REMOTE_HOST = os.getenv('SSH_HOST', '45.159.230.42')
REMOTE_PORT = int(os.getenv('SSH_PORT', '1511'))
REMOTE_USER = os.getenv('SSH_USERNAME', 'root')
SSH_KEY_PATH = os.getenv('SSH_KEY_PATH', None)  # Will use default SSH key
AGENT_PATH = "/tmp/sshsshje-1.0.0-source"
CONFIG_PATH = f"{AGENT_PATH}/sshsshje-agent-config.yaml"

# Security Configuration
API_KEY = os.getenv('API_KEY', None)  # Set this in production
ENABLE_AUTH = os.getenv('ENABLE_AUTH', 'false').lower() == 'true'

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Pydantic models for type validation
class RestartRequest(BaseModel):
    type: str  # "service" or "container"
    name: str

class ResolveRequest(BaseModel):
    issue_id: str

# SSH Connection Pool
class SSHConnectionPool:
    def __init__(self, host: str, port: int, username: str, max_connections: int = 5):
        self.host = host
        self.port = port
        self.username = username
        self.max_connections = max_connections
        self._pool = []
        self._in_use = set()
        
    async def get_connection(self) -> paramiko.SSHClient:
        """Get an SSH connection from the pool"""
        # Try to reuse existing connection
        for client in self._pool:
            if client not in self._in_use:
                try:
                    # Test connection
                    client.exec_command('echo "test"', timeout=5)
                    self._in_use.add(client)
                    return client
                except:
                    # Connection is dead, remove it
                    self._pool.remove(client)
                    try:
                        client.close()
                    except:
                        pass
        
        # Create new connection if pool not full
        if len(self._pool) < self.max_connections:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            
            try:
                client.connect(
                    hostname=self.host,
                    port=self.port,
                    username=self.username,
                    timeout=10,
                    allow_agent=True,
                    look_for_keys=True
                )
                self._pool.append(client)
                self._in_use.add(client)
                logger.info(f"Created new SSH connection to {self.host}:{self.port}")
                return client
            except Exception as e:
                logger.error(f"Failed to create SSH connection: {e}")
                raise HTTPException(status_code=503, detail=f"Cannot connect to remote server: {e}")
        
        raise HTTPException(status_code=503, detail="SSH connection pool exhausted")
    
    def release_connection(self, client: paramiko.SSHClient):
        """Return connection to pool"""
        if client in self._in_use:
            self._in_use.remove(client)

# Global connection pool
ssh_pool = SSHConnectionPool(REMOTE_HOST, REMOTE_PORT, REMOTE_USER)

# WebSocket connection manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"WebSocket connected. Total connections: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        logger.info(f"WebSocket disconnected. Total connections: {len(self.active_connections)}")

    async def broadcast(self, message: dict):
        if self.active_connections:
            dead_connections = []
            for connection in self.active_connections:
                try:
                    await connection.send_json(message)
                except Exception as e:
                    logger.warning(f"Failed to send message to WebSocket: {e}")
                    dead_connections.append(connection)
            
            # Remove dead connections
            for dead in dead_connections:
                self.disconnect(dead)

manager = ConnectionManager()

# Security and Authentication
security = HTTPBearer(auto_error=False)

async def verify_api_key(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Verify API key if authentication is enabled"""
    if not ENABLE_AUTH:
        return True
    
    if not credentials or not API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    if credentials.credentials != API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    return True

# Dependency for protected routes
def get_auth_dependency():
    return Depends(verify_api_key) if ENABLE_AUTH else None

# SSH Command execution helper
async def execute_ssh_command(command: str, timeout: int = 30) -> Dict[str, Any]:
    """Execute command on remote server via SSH"""
    client = await ssh_pool.get_connection()
    try:
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        
        # Read output
        stdout_data = stdout.read().decode('utf-8')
        stderr_data = stderr.read().decode('utf-8')
        exit_status = stdout.channel.recv_exit_status()
        
        return {
            'stdout': stdout_data,
            'stderr': stderr_data,
            'exit_status': exit_status,
            'success': exit_status == 0
        }
    
    except Exception as e:
        logger.error(f"SSH command failed: {e}")
        return {
            'stdout': '',
            'stderr': str(e),
            'exit_status': -1,
            'success': False
        }
    finally:
        ssh_pool.release_connection(client)

# Agent command wrappers
async def get_system_metrics() -> Dict[str, Any]:
    """Get real system metrics from remote server"""
    try:
        # Execute multiple commands in parallel
        commands = {
            'cpu': "python3 -c \"import psutil; print(psutil.cpu_percent(interval=1))\"",
            'memory': "python3 -c \"import psutil,json; m=psutil.virtual_memory(); print(json.dumps({'total':m.total,'available':m.available,'percent':m.percent,'used':m.used,'free':m.free}))\"",
            'disk': "python3 -c \"import psutil,json; d=psutil.disk_usage('/'); print(json.dumps({'total':d.total,'used':d.used,'free':d.free,'percent':round(d.used/d.total*100,1)}))\"",
            'load': "python3 -c \"import psutil,json; l=psutil.getloadavg(); print(json.dumps({'load1':l[0],'load5':l[1],'load15':l[2]}))\"",
            'network': "python3 -c \"import psutil,json; n=psutil.net_io_counters(); print(json.dumps({'bytes_sent':n.bytes_sent,'bytes_recv':n.bytes_recv,'packets_sent':n.packets_sent,'packets_recv':n.packets_recv}))\""
        }
        
        results = {}
        for key, cmd in commands.items():
            result = await execute_ssh_command(cmd)
            if result['success']:
                try:
                    if key == 'cpu':
                        results[key] = float(result['stdout'].strip())
                    else:
                        results[key] = json.loads(result['stdout'].strip())
                except:
                    logger.warning(f"Failed to parse {key} data: {result['stdout']}")
                    results[key] = None
        
        return {
            'cpu_usage': results.get('cpu', 0),
            'memory': results.get('memory', {}),
            'disk': {'/': results.get('disk', {})},
            'load_average': results.get('load', {}),
            'network': results.get('network', {}),
            'timestamp': int(time.time())
        }
    
    except Exception as e:
        logger.error(f"Failed to get system metrics: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get system metrics: {e}")

async def get_services_status() -> Dict[str, Any]:
    """Get services status from remote server"""
    try:
        services = ['ssh', 'nginx', 'docker', 'postgresql', 'redis-server']
        cmd = f"""python3 -c "
import subprocess, json
services = {services}
result = {{'services': {{}}}}
healthy = 0
for svc in services:
    try:
        active = subprocess.run(['systemctl', 'is-active', svc], capture_output=True, text=True).stdout.strip() == 'active'
        enabled = subprocess.run(['systemctl', 'is-enabled', svc], capture_output=True, text=True).stdout.strip() == 'enabled'
        status = 'running' if active else 'stopped'
        result['services'][svc] = {{'service': svc, 'active': active, 'enabled': enabled, 'status': status}}
        if active: healthy += 1
    except:
        result['services'][svc] = {{'service': svc, 'active': False, 'enabled': False, 'status': 'unknown'}}
result['healthy_count'] = healthy
result['unhealthy_count'] = len(services) - healthy
print(json.dumps(result))
"
"""
        
        result = await execute_ssh_command(cmd)
        if result['success']:
            return json.loads(result['stdout'].strip())
        else:
            raise Exception(f"Command failed: {result['stderr']}")
    
    except Exception as e:
        logger.error(f"Failed to get services status: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get services status: {e}")

async def get_containers_status() -> Dict[str, Any]:
    """Get Docker containers status"""
    try:
        cmd = """python3 -c "
import subprocess, json
try:
    result = subprocess.run(['docker', 'ps', '-a', '--format', 'json'], capture_output=True, text=True)
    containers = []
    if result.returncode == 0:
        for line in result.stdout.strip().split('\\n'):
            if line.strip():
                try:
                    containers.append(json.loads(line))
                except:
                    pass
    
    running = sum(1 for c in containers if c.get('State', '').lower() == 'running')
    stopped = len(containers) - running
    
    formatted = []
    for c in containers:
        formatted.append({
            'id': c.get('ID', '')[:12],
            'name': c.get('Names', ''),
            'image': c.get('Image', ''),
            'status': c.get('Status', ''),
            'state': c.get('State', '').lower()
        })
    
    print(json.dumps({
        'total': len(containers),
        'running': running,
        'stopped': stopped,
        'unhealthy': 0,
        'containers': formatted
    }))
except Exception as e:
    print(json.dumps({'total': 0, 'running': 0, 'stopped': 0, 'unhealthy': 0, 'containers': [], 'error': str(e)}))
"
"""
        
        result = await execute_ssh_command(cmd)
        if result['success']:
            return json.loads(result['stdout'].strip())
        else:
            raise Exception(f"Command failed: {result['stderr']}")
    
    except Exception as e:
        logger.error(f"Failed to get containers status: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get containers status: {e}")

async def get_applications_status() -> Dict[str, Any]:
    """Get application health status"""
    try:
        # Use environment variable or default to SSH host
        remote_host = os.getenv('REMOTE_HOST', '45.159.230.42')
        
        apps = {
            'cbl_frontend': f'http://{remote_host}:9001',
            'cbl_backend': f'http://{remote_host}:8001/api/health', 
            'cbl_mobile': f'http://{remote_host}:8081',
            'guacamole': f'http://{remote_host}:8080/guacamole'
        }
        
        cmd = f"""python3 -c "
import requests, time, json
apps = {apps}
result = {{'applications': {{}}}}
healthy = 0

for name, url in apps.items():
    try:
        start = time.time()
        response = requests.get(url, timeout=5)
        response_time = time.time() - start
        
        result['applications'][name] = {{
            'name': name.replace('_', ' ').title(),
            'url': url,
            'healthy': 200 <= response.status_code < 400,
            'status_code': response.status_code,
            'response_time': round(response_time, 2),
            'error': None
        }}
        if 200 <= response.status_code < 400:
            healthy += 1
    except Exception as e:
        result['applications'][name] = {{
            'name': name.replace('_', ' ').title(),
            'url': url,
            'healthy': False,
            'status_code': None,
            'response_time': None,
            'error': str(e)
        }}

result['healthy_count'] = healthy
result['unhealthy_count'] = len(apps) - healthy
print(json.dumps(result))
"
"""
        
        result = await execute_ssh_command(cmd)
        if result['success']:
            return json.loads(result['stdout'].strip())
        else:
            raise Exception(f"Command failed: {result['stderr']}")
    
    except Exception as e:
        logger.error(f"Failed to get applications status: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get applications status: {e}")

async def get_security_status() -> Dict[str, Any]:
    """Get security monitoring data"""
    try:
        cmd = """python3 -c "
import subprocess, json, re
from datetime import datetime

result = {'firewall': {}, 'active_sessions': [], 'failed_logins': {}}

# Firewall status
try:
    ufw_result = subprocess.run(['ufw', 'status', 'verbose'], capture_output=True, text=True)
    result['firewall'] = {
        'enabled': 'Status: active' in ufw_result.stdout,
        'default_incoming': 'deny',
        'default_outgoing': 'allow',
        'rules': [line.strip() for line in ufw_result.stdout.split('\\n') if 'ALLOW' in line or 'DENY' in line][:10]
    }
except:
    result['firewall'] = {'enabled': False, 'rules': []}

# Active sessions
try:
    who_result = subprocess.run(['who'], capture_output=True, text=True)
    sessions = []
    for line in who_result.stdout.split('\\n'):
        if line.strip():
            parts = line.split()
            if len(parts) >= 3:
                sessions.append({
                    'user': parts[0],
                    'terminal': parts[1],
                    'login_time': ' '.join(parts[2:4]) if len(parts) >= 4 else parts[2],
                    'ip': parts[4].strip('()') if len(parts) >= 5 and '(' in parts[4] else None
                })
    result['active_sessions'] = sessions
except:
    result['active_sessions'] = []

# Failed logins from auth.log
try:
    auth_result = subprocess.run(['tail', '-100', '/var/log/auth.log'], capture_output=True, text=True)
    failed_attempts = []
    ip_counts = {}
    
    for line in auth_result.stdout.split('\\n'):
        if 'Failed password' in line and 'ssh' in line:
            parts = line.split()
            if len(parts) > 10:
                timestamp = ' '.join(parts[:3])
                # Extract IP and user
                ip_match = re.search(r'from ([\\d.]+)', line)
                user_match = re.search(r'for ([\\w]+)', line)
                
                ip = ip_match.group(1) if ip_match else None
                user = user_match.group(1) if user_match else None
                
                if ip:
                    ip_counts[ip] = ip_counts.get(ip, 0) + 1
                
                failed_attempts.append({
                    'timestamp': timestamp,
                    'success': False,
                    'user': user,
                    'ip': ip,
                    'raw_line': line.strip()
                })
    
    # Sort by frequency
    top_ips = sorted(ip_counts.items(), key=lambda x: x[1], reverse=True)[:5]
    
    result['failed_logins'] = {
        'total_failed': len(failed_attempts),
        'recent_attempts': failed_attempts[-10:],
        'top_attacking_ips': top_ips,
        'top_targeted_users': []
    }
except:
    result['failed_logins'] = {'total_failed': 0, 'recent_attempts': [], 'top_attacking_ips': [], 'top_targeted_users': []}

result['timestamp'] = int(datetime.now().timestamp())
print(json.dumps(result))
"
"""
        
        result = await execute_ssh_command(cmd)
        if result['success']:
            return json.loads(result['stdout'].strip())
        else:
            raise Exception(f"Command failed: {result['stderr']}")
    
    except Exception as e:
        logger.error(f"Failed to get security status: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get security status: {e}")

async def get_diagnostics() -> Dict[str, Any]:
    """Get system diagnostics and health score"""
    try:
        # Basic health checks
        system = await get_system_metrics()
        services = await get_services_status()
        containers = await get_containers_status()
        
        issues = []
        health_score = 100
        
        # Check system resources
        if system.get('cpu_usage', 0) > 80:
            issues.append({
                'id': f'cpu_high_{int(time.time())}',
                'severity': 'warning',
                'category': 'system',
                'title': 'High CPU usage',
                'description': f"CPU usage is {system['cpu_usage']:.1f}%",
                'resolution': 'Check running processes and optimize resource usage',
                'can_auto_resolve': False
            })
            health_score -= 15
        
        memory_percent = system.get('memory', {}).get('percent', 0)
        if memory_percent > 90:
            issues.append({
                'id': f'memory_high_{int(time.time())}',
                'severity': 'critical',
                'category': 'system',
                'title': 'High memory usage',
                'description': f"Memory usage is {memory_percent:.1f}%",
                'resolution': 'Restart memory-intensive services or increase memory',
                'can_auto_resolve': False
            })
            health_score -= 25
        
        disk_percent = system.get('disk', {}).get('/', {}).get('percent', 0)
        if disk_percent > 85:
            issues.append({
                'id': f'disk_full_{int(time.time())}',
                'severity': 'warning',
                'category': 'system',
                'title': 'Disk space low',
                'description': f"Disk usage is {disk_percent:.1f}%",
                'resolution': 'Clean temporary files and logs',
                'can_auto_resolve': True
            })
            health_score -= 20
        
        # Check services
        unhealthy_services = services.get('unhealthy_count', 0)
        if unhealthy_services > 0:
            for service_name, service_data in services.get('services', {}).items():
                if not service_data.get('active', True):
                    issues.append({
                        'id': f'service_{service_name}_{int(time.time())}',
                        'severity': 'critical',
                        'category': 'service',
                        'title': f'{service_name} service stopped',
                        'description': f'Service {service_name} is not running',
                        'resolution': f'Restart {service_name} service',
                        'can_auto_resolve': True
                    })
                    health_score -= 15
        
        # Check containers
        stopped_containers = containers.get('stopped', 0)
        if stopped_containers > 0:
            health_score -= (stopped_containers * 10)
        
        return {
            'timestamp': int(time.time()),
            'issues': issues,
            'health_score': max(0, health_score)
        }
    
    except Exception as e:
        logger.error(f"Failed to get diagnostics: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get diagnostics: {e}")

async def get_history() -> Dict[str, Any]:
    """Get historical data (simplified for now)"""
    try:
        # For now, generate some sample historical data
        # In a real implementation, this would come from stored metrics
        current_time = int(time.time())
        metrics = []
        
        # Generate last 24 hours of data (every 5 minutes)
        for i in range(288):  # 24 * 60 / 5
            timestamp = current_time - (i * 300)  # 5 minutes ago
            metrics.append({
                'timestamp': timestamp,
                'cpu_usage': 30 + (i % 40),
                'memory_usage': 45 + (i % 30), 
                'disk_usage': 35 + (i % 15),
                'load_average': 0.5 + (i % 20) / 10
            })
        
        return {
            'metrics': list(reversed(metrics)),
            'alerts': [],
            'service_events': []
        }
    
    except Exception as e:
        logger.error(f"Failed to get history: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get history: {e}")

# Background task for real-time updates
async def broadcast_system_updates():
    """Background task to broadcast system updates via WebSocket"""
    while True:
        try:
            if manager.active_connections:
                system_data = await get_system_metrics()
                await manager.broadcast({
                    'type': 'system_update',
                    'payload': system_data
                })
            
            await asyncio.sleep(30)  # Update every 30 seconds
        
        except Exception as e:
            logger.error(f"Error in background update task: {e}")
            await asyncio.sleep(60)  # Wait longer if error

# FastAPI app setup
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start background task
    task = asyncio.create_task(broadcast_system_updates())
    logger.info("Started background system updates task")
    yield
    # Cleanup
    task.cancel()
    logger.info("Stopped background system updates task")

app = FastAPI(
    title="SSHSshje Monitoring API",
    description="Real-time monitoring API for CBL Basketball Platform",
    version="1.0.0",
    lifespan=lifespan
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5577", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API Routes
@app.get("/api/system")
async def system_metrics(auth: bool = Depends(verify_api_key)):
    """Get current system metrics"""
    return await get_system_metrics()

@app.get("/api/services")
async def services_status(auth: bool = Depends(verify_api_key)):
    """Get services status"""
    return await get_services_status()

@app.get("/api/containers") 
async def containers_status(auth: bool = Depends(verify_api_key)):
    """Get containers status"""
    return await get_containers_status()

@app.get("/api/applications")
async def applications_status(auth: bool = Depends(verify_api_key)):
    """Get applications health"""
    return await get_applications_status()

@app.get("/api/security")
async def security_status(auth: bool = Depends(verify_api_key)):
    """Get security monitoring data"""
    return await get_security_status()

@app.get("/api/diagnostics")
async def diagnostics(auth: bool = Depends(verify_api_key)):
    """Get system diagnostics"""
    return await get_diagnostics()

@app.get("/api/history")
async def history(days: int = 1, auth: bool = Depends(verify_api_key)):
    """Get historical metrics"""
    return await get_history()

# Action endpoints (require authentication)
@app.post("/api/actions/restart")
async def restart_service_or_container(request: RestartRequest, auth: bool = Depends(verify_api_key)):
    """Restart a service or container"""
    try:
        if request.type == "service":
            cmd = f"sudo systemctl restart {request.name}"
        elif request.type == "container":
            cmd = f"docker restart {request.name}"
        else:
            raise HTTPException(status_code=400, detail="Type must be 'service' or 'container'")
        
        result = await execute_ssh_command(cmd, timeout=60)
        
        if result['success']:
            return {
                'success': True,
                'message': f"Successfully restarted {request.type} {request.name}",
                'details': result
            }
        else:
            raise HTTPException(
                status_code=500, 
                detail=f"Failed to restart {request.type} {request.name}: {result['stderr']}"
            )
    
    except Exception as e:
        logger.error(f"Restart failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/actions/resolve")
async def resolve_issue(request: ResolveRequest, auth: bool = Depends(verify_api_key)):
    """Auto-resolve an issue"""
    try:
        # Simple auto-resolution logic
        actions_taken = []
        
        if "disk" in request.issue_id.lower():
            # Clean temporary files
            cmd = "sudo find /tmp -type f -atime +7 -delete && sudo journalctl --vacuum-time=7d"
            result = await execute_ssh_command(cmd)
            if result['success']:
                actions_taken.append("Cleaned temporary files and old logs")
        
        elif "service" in request.issue_id.lower():
            # Extract service name from issue_id
            service_name = request.issue_id.split('_')[1] if '_' in request.issue_id else 'unknown'
            cmd = f"sudo systemctl restart {service_name}"
            result = await execute_ssh_command(cmd)
            if result['success']:
                actions_taken.append(f"Restarted {service_name} service")
        
        return {
            'success': True,
            'message': f"Issue {request.issue_id} resolved",
            'actions_taken': actions_taken
        }
    
    except Exception as e:
        logger.error(f"Resolution failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# WebSocket endpoint
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # Send initial system data
        try:
            system_data = await get_system_metrics()
            await websocket.send_json({
                'type': 'system_update',
                'payload': system_data
            })
        except Exception as e:
            logger.warning(f"Failed to send initial data: {e}")
        
        # Keep connection alive and send periodic updates
        while True:
            try:
                # Send system update every 30 seconds
                await asyncio.sleep(30)
                
                # Check if connection is still alive
                await websocket.send_json({
                    'type': 'ping',
                    'timestamp': int(time.time())
                })
                
                # Send fresh system data
                system_data = await get_system_metrics()
                await websocket.send_json({
                    'type': 'system_update',
                    'payload': system_data
                })
                
            except Exception as e:
                logger.warning(f"Error in WebSocket loop: {e}")
                break
    
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected normally")
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        manager.disconnect(websocket)

# Health check
@app.get("/health")
async def health_check():
    """Health check endpoint"""
    try:
        # Test SSH connection
        result = await execute_ssh_command("echo 'connected'", timeout=5)
        return {
            'status': 'healthy',
            'ssh_connection': result['success'],
            'timestamp': int(time.time())
        }
    except Exception as e:
        return {
            'status': 'unhealthy', 
            'error': str(e),
            'timestamp': int(time.time())
        }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=3001,
        log_level="info",
        reload=False
    )