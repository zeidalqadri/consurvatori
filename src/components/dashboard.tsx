import React, { useCallback, useEffect, useMemo, useRef, useState, memo, Suspense, ErrorBoundary } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, CartesianGrid } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Activity, Cpu, HardDrive, MemoryStick, Network, Terminal, RefreshCw, Bug, ShieldHalf, X, Search, RotateCw, AlertTriangle, ShieldAlert, ChevronDown, ChevronUp, Play, Square, Pause, FileText, Settings, BarChart3, Clock, Zap, CheckCircle, XCircle, AlertCircle } from "lucide-react";

// -------------------------------------------------------------
// Config
// -------------------------------------------------------------
const BASE = process.env.NEXT_PUBLIC_AGENT_BASE ?? ""; // Use relative URL for same-origin requests
const WS_URL = process.env.NEXT_PUBLIC_AGENT_WS; // Let it derive from location if undefined

// Accent + palette for mild Mr‑Robot vibe
const theme = {
  bg: "#0b0f10",
  panel: "#0f1416",
  ink: "#e6ffee",
  sub: "#9fe6c3",
  neon: "#00ff9c",
  neonDim: "#0bd47a",
  warn: "#f5a524",
  crit: "#ff4d4f",
  grid: "#203036",
};

// -------------------------------------------------------------
// Types (aligned to provided JSON schema)
// -------------------------------------------------------------
interface MemoryInfo { total: number; available: number; percent: number; used: number; free: number }
interface DiskMount { total: number; used: number; free: number; percent: number }
interface SystemResponse {
  cpu_usage: number;
  memory: MemoryInfo;
  disk: Record<string, DiskMount>; // keyed by mount point (e.g., "/")
  load_average: { load1: number; load5: number; load15: number };
  network: { bytes_sent: number; bytes_recv: number; packets_sent: number; packets_recv: number };
  timestamp: number;
}

interface ContainersResponse {
  total: number; running: number; stopped: number; unhealthy: number;
  containers: Array<{ id: string; name: string; image: string; status: string; state: "running"|"exited"|"created"|"restarting"|"paused" }>
}

interface AppEntry { name: string; url: string; healthy: boolean; status_code: number | null; response_time: number | null; error: string | null }
interface ApplicationsResponse {
  healthy_count: number; unhealthy_count: number;
  applications: Record<string, AppEntry> // cbl_frontend, cbl_backend, cbl_mobile, guacamole
}

interface ServiceEntry { 
  service: string; 
  active: boolean; 
  enabled: boolean; 
  status: "running"|"stopped"|"unknown";
  // Enhanced properties that may be available
  pid?: number;
  uptime?: string;
  memory?: number;
  cpu?: number;
  user?: string;
  description?: string;
  last_error?: string;
}
interface ServicesResponse {
  healthy_count: number; unhealthy_count: number;
  services: Record<string, ServiceEntry>
}

interface SecurityResponse {
  firewall: { enabled: boolean; default_incoming: string; default_outgoing: string; rules: string[] };
  active_sessions: Array<{ user: string; terminal: string; login_time: string; ip: string | null }>;
  failed_logins: {
    total_failed: number;
    recent_attempts: Array<{ timestamp: string; success: boolean; user: string | null; ip: string | null; raw_line: string }>;
    top_attacking_ips: Array<[string, number]>;
    top_targeted_users: Array<[string, number]>;
  };
  timestamp: number;
}

interface DiagnosticIssue {
  id: string; severity: "critical"|"warning"|"info"; category: "system"|"service"|"container"|"application"|"security";
  title: string; description: string; resolution: string; can_auto_resolve: boolean;
}
interface DiagnosticsResponse { timestamp: number; issues: DiagnosticIssue[]; health_score: number }

interface HistoryPoint { timestamp: number; cpu_usage: number; memory_usage: number; disk_usage: number; load_average: number }
interface HistoryEvent { timestamp: number; severity: string; category: string; message: string; resolved: boolean }
interface ServiceEvent { timestamp: number; service: string; event: "started"|"stopped"|"restarted"|"failed"; details: string }
interface HistoryResponse {
  metrics: HistoryPoint[];
  alerts: HistoryEvent[];
  service_events: ServiceEvent[];
}

// -------------------------------------------------------------
// Utilities
// -------------------------------------------------------------
const pct = (x?: number) => (typeof x === "number" ? `${x.toFixed(0)}%` : "—");
const fmtB = (b: number) => {
  const units = ["B","KB","MB","GB","TB"]; let i=0; let v=b; while (v>=1024 && i<units.length-1){v/=1024;i++} return `${v.toFixed(1)} ${units[i]}`;
};
const since = (t: number | string) => {
  const ms = typeof t === 'string' ? (new Date(t).getTime()) : t*1000;
  const d = Date.now() - ms; const m = Math.floor(d/60000); if (m<1) return "just now"; if (m<60) return `${m}m`; const h=Math.floor(m/60); if(h<24) return `${h}h`; return `${Math.floor(h/24)}d`;
};
const sleep = (ms:number) => new Promise(res => setTimeout(res, ms));

const useAbortable = () => {
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);
  return () => {
    ctrl.current?.abort();
    ctrl.current = new AbortController();
    return ctrl.current.signal;
  };
};

function useApi<T>(path: string | null, intervalSec?: number, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const nextSignal = useAbortable();

  const fetcher = useCallback(async () => {
    if (!path || !enabled) return;
    try {
      setLoading(true);
      const res = await fetch(`${BASE}${path}`, { signal: nextSignal() });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      setData(json as T);
      setError(null);
    } catch (e:any) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [path, enabled]);

  useEffect(() => {
    fetcher();
    if (intervalSec && enabled) {
      const id = setInterval(fetcher, intervalSec*1000);
      return () => clearInterval(id);
    }
  }, [fetcher, intervalSec, enabled]);

  return { data, error, loading, refetch: fetcher } as const;
}

// Enhanced WebSocket hook with reconnection logic
function useAgentSocket(onMessage: (msg: any) => void, enabled = true) {
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 10;
  const wsRef = useRef<WebSocket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');

  const connect = useCallback(() => {
    if (!enabled) return;
    
    let url = WS_URL;
    if (!url && typeof window !== 'undefined') {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      url = `${proto}://${window.location.host}/ws`;
    }
    if (!url) return;

    setConnectionStatus('connecting');
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionStatus('connected');
      reconnectAttempts.current = 0;
      console.log('[WS] Connected to agent');
    };

    ws.onmessage = (ev) => {
      try { 
        const msg = JSON.parse(ev.data); 
        onMessage(msg); 
      } catch (e) {
        console.warn('[WS] Failed to parse message:', e);
      }
    };

    ws.onerror = (err) => {
      console.error('[WS] Connection error:', err);
    };

    ws.onclose = (ev) => {
      setConnectionStatus('disconnected');
      wsRef.current = null;
      
      // Implement exponential backoff reconnection
      if (enabled && reconnectAttempts.current < maxReconnectAttempts) {
        const backoffDelay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
        reconnectAttempts.current++;
        
        console.log(`[WS] Connection closed, reconnecting in ${backoffDelay}ms (attempt ${reconnectAttempts.current})`);
        setTimeout(connect, backoffDelay);
      } else {
        console.error('[WS] Max reconnection attempts reached');
      }
    };
  }, [enabled, onMessage]);

  useEffect(() => {
    connect();
    
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { connectionStatus, reconnect: connect };
}

// -------------------------------------------------------------
// Loading Skeletons
// -------------------------------------------------------------
function SkeletonCard({ className = "" }: { className?: string }) {
  return (
    <Card className={`bg-[#0f1416] border-[#1a2a2f] ${className}`}>
      <CardHeader className="pb-2">
        <div className="h-4 bg-[#1a2a2f] rounded animate-pulse"/>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-2">
          <div className="h-3 bg-[#1a2a2f] rounded animate-pulse"/>
          <div className="h-3 bg-[#1a2a2f] rounded animate-pulse w-3/4"/>
        </div>
      </CardContent>
    </Card>
  );
}

function MetricsSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({length: 4}).map((_, i) => (
        <SkeletonCard key={i}/>
      ))}
      <SkeletonCard className="sm:col-span-2 lg:col-span-4"/>
    </div>
  );
}

function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Card className="bg-[#0f1416] border-[#1a2a2f]">
      <CardHeader className="pb-2">
        <div className="h-4 bg-[#1a2a2f] rounded animate-pulse w-32"/>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-3">
          {Array.from({length: rows}).map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <div className="w-2 h-2 bg-[#1a2a2f] rounded-full"/>
              <div className="flex-1 h-3 bg-[#1a2a2f] rounded animate-pulse"/>
              <div className="w-16 h-6 bg-[#1a2a2f] rounded animate-pulse"/>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// Error Boundary Component
class DashboardErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ComponentType },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Dashboard error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      const Fallback = this.props.fallback || (() => (
        <Card className="bg-[#0f1416] border-[#ff4d4f] border-2">
          <CardContent className="p-6 text-center">
            <AlertTriangle className="h-8 w-8 text-[#ff4d4f] mx-auto mb-2"/>
            <div className="text-sm text-[#ff4d4f] font-medium mb-2">Component Error</div>
            <div className="text-xs text-[#9fe6c3]/70">{this.state.error?.message || 'Unknown error occurred'}</div>
            <Button 
              size="sm" 
              variant="outline" 
              className="mt-3 border-[#ff4d4f] text-[#ff4d4f]"
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ));
      return <Fallback />;
    }

    return this.props.children;
  }
}

// -------------------------------------------------------------
// Small primitives
// -------------------------------------------------------------
function CRTOverlay() {
  // very subtle scanlines + vignetting
  return (
    <div className="pointer-events-none fixed inset-0 z-[-1]" aria-hidden>
      <div style={{
        background: `repeating-linear-gradient(0deg, rgba(255,255,255,0.02) 0px, rgba(255,255,255,0.02) 1px, transparent 2px, transparent 3px)`
      }} className="absolute inset-0"/>
      <div style={{ boxShadow: 'inset 0 0 180px rgba(0,0,0,0.7)' }} className="absolute inset-0"/>
    </div>
  );
}

function GlitchTitle({children}:{children: React.ReactNode}){
  return (
    <div className="relative font-mono tracking-tight">
      <span className="text-[hsl(150,100%,75%)]">{children}</span>
      <span className="absolute left-[1px] top-0 blur-[0.5px] opacity-40 text-[hsl(150,100%,50%)] translate-x-[0.5px] select-none" aria-hidden>{children}</span>
      <span className="absolute left-[-1px] top-[0.5px] blur-[0.5px] opacity-30 text-[hsl(190,100%,60%)] -translate-x-[0.5px] select-none" aria-hidden>{children}</span>
    </div>
  );
}

function Dot({status}:{status: 'ok'|'warn'|'crit'|'idle'}){
  const map = { ok: theme.neon, warn: theme.warn, crit: theme.crit, idle: '#6b7280' } as const;
  return <span className="inline-block w-2 h-2 rounded-full" style={{background: map[status]}}/>;
}

function GaugeCircle({value=0,label}:{value:number;label:string}){
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-4">
      <div className="relative w-16 h-16" title={pct(v)}>
        <div className="absolute inset-0 rounded-full" style={{
          background: `conic-gradient(${theme.neon} ${v*3.6}deg, #1c2a23 ${v*3.6}deg)`
        }}/>
        <div className="absolute inset-1 rounded-full bg-[#0f1416] flex items-center justify-center text-xs text-[${theme.sub}]">
          {Math.round(v)}%
        </div>
      </div>
      <div className="text-sm text-[color:var(--sub,#9fe6c3)] opacity-80">{label}</div>
    </div>
  );
}

// -------------------------------------------------------------
// Panels
// -------------------------------------------------------------
function MetricsGrid({sys}:{sys:SystemResponse|null}){
  const diskRoot = sys?.disk?.["/"] ?? Object.values(sys?.disk ?? {})[0];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card className="bg-[#0f1416] border-[#1a2a2f]">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-[#9fe6c3] flex items-center gap-2"><Cpu size={16}/> CPU</CardTitle></CardHeader>
        <CardContent className="pt-0"><GaugeCircle value={sys?.cpu_usage ?? 0} label="Usage"/></CardContent>
      </Card>
      <Card className="bg-[#0f1416] border-[#1a2a2f]">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-[#9fe6c3] flex items-center gap-2"><MemoryStick size={16}/> Memory</CardTitle></CardHeader>
        <CardContent className="pt-0"><GaugeCircle value={sys?.memory?.percent ?? 0} label={`${fmtB(sys?.memory?.used ?? 0)} / ${fmtB(sys?.memory?.total ?? 0)}`}/></CardContent>
      </Card>
      <Card className="bg-[#0f1416] border-[#1a2a2f]">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-[#9fe6c3] flex items-center gap-2"><HardDrive size={16}/> Disk</CardTitle></CardHeader>
        <CardContent className="pt-0"><GaugeCircle value={diskRoot?.percent ?? 0} label={`${fmtB(diskRoot?.used ?? 0)} / ${fmtB(diskRoot?.total ?? 0)}`}/></CardContent>
      </Card>
      <Card className="bg-[#0f1416] border-[#1a2a2f]">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-[#9fe6c3] flex items-center gap-2"><Activity size={16}/> Load</CardTitle></CardHeader>
        <CardContent className="pt-0 text-sm text-[#9fe6c3]/80">1m {sys?.load_average?.load1?.toFixed(2)} • 5m {sys?.load_average?.load5?.toFixed(2)} • 15m {sys?.load_average?.load15?.toFixed(2)}</CardContent>
      </Card>
      <Card className="bg-[#0f1416] border-[#1a2a2f] sm:col-span-2 lg:col-span-4">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-[#9fe6c3] flex items-center gap-2"><Network size={16}/> Network</CardTitle></CardHeader>
        <CardContent className="pt-0 text-sm text-[#9fe6c3]/80 flex flex-wrap gap-6">
          <div>Sent: <span className="text-[#e6ffee]">{fmtB(sys?.network?.bytes_sent ?? 0)}</span></div>
          <div>Recv: <span className="text-[#e6ffee]">{fmtB(sys?.network?.bytes_recv ?? 0)}</span></div>
          <div>Pkts ↑: <span className="text-[#e6ffee]">{sys?.network?.packets_sent ?? 0}</span></div>
          <div>Pkts ↓: <span className="text-[#e6ffee]">{sys?.network?.packets_recv ?? 0}</span></div>
        </CardContent>
      </Card>
    </div>
  );
}

// Enhanced Service Card Component
interface ServiceCardProps {
  service: ServiceEntry;
  onRestart: (name: string) => void;
  onStart: (name: string) => void;
  onStop: (name: string) => void;
  onViewLogs: (name: string) => void;
  disabled?: boolean;
}

function ServiceCard({ service, onRestart, onStart, onStop, onViewLogs, disabled }: ServiceCardProps) {
  const [expanded, setExpanded] = useState(false);
  
  const getStatusInfo = () => {
    if (service.status === 'running') {
      return { 
        icon: CheckCircle, 
        color: 'text-green-400', 
        bg: 'bg-green-400/10', 
        status: 'ok' as const,
        text: 'Running'
      };
    } else if (service.status === 'stopped') {
      return { 
        icon: XCircle, 
        color: 'text-red-400', 
        bg: 'bg-red-400/10', 
        status: 'crit' as const,
        text: 'Stopped'
      };
    } else {
      return { 
        icon: AlertCircle, 
        color: 'text-amber-400', 
        bg: 'bg-amber-400/10', 
        status: 'warn' as const,
        text: 'Unknown'
      };
    }
  };

  const statusInfo = getStatusInfo();
  const StatusIcon = statusInfo.icon;

  return (
    <div className="rounded-lg border border-[#1a2a2f] bg-[#0e1315] overflow-hidden">
      {/* Main Service Info */}
      <div className="p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 flex-1">
            <div className={`p-1.5 rounded-full ${statusInfo.bg}`}>
              <StatusIcon className={`h-4 w-4 ${statusInfo.color}`} />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-[#e6ffee] font-medium">{service.service}</span>
                <Badge 
                  variant="outline" 
                  className={`text-xs ${statusInfo.color} border-current`}
                >
                  {statusInfo.text}
                </Badge>
              </div>
              {service.description && (
                <p className="text-xs text-[#9fe6c3]/60 mt-1">{service.description}</p>
              )}
              {service.last_error && service.status !== 'running' && (
                <p className="text-xs text-red-400 mt-1 truncate">{service.last_error}</p>
              )}
            </div>
          </div>
          
          <div className="flex items-center gap-1">
            {/* Quick Actions */}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-[#9fe6c3] hover:bg-[#10201a]"
              onClick={() => onViewLogs(service.service)}
              disabled={disabled}
              title="View logs"
            >
              <FileText className="h-3 w-3" />
            </Button>
            
            {service.status === 'running' ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-amber-400 hover:bg-amber-400/10"
                  onClick={() => onRestart(service.service)}
                  disabled={disabled}
                  title="Restart service"
                >
                  <RotateCw className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-red-400 hover:bg-red-400/10"
                  onClick={() => onStop(service.service)}
                  disabled={disabled}
                  title="Stop service"
                >
                  <Square className="h-3 w-3" />
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-green-400 hover:bg-green-400/10"
                onClick={() => onStart(service.service)}
                disabled={disabled}
                title="Start service"
              >
                <Play className="h-3 w-3" />
              </Button>
            )}
            
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-[#9fe6c3] hover:bg-[#10201a]"
              onClick={() => setExpanded(!expanded)}
              title={expanded ? "Collapse details" : "Expand details"}
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </Button>
          </div>
        </div>
        
        {/* Basic status info always visible */}
        <div className="flex items-center gap-4 mt-2 text-xs text-[#9fe6c3]/70">
          <div className="flex items-center gap-1">
            <span>{service.active ? 'Active' : 'Inactive'}</span>
          </div>
          <div className="flex items-center gap-1">
            <span>{service.enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
          {service.uptime && service.status === 'running' && (
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              <span>{service.uptime}</span>
            </div>
          )}
        </div>
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="border-t border-[#1a2a2f] bg-[#0b1113] p-3 space-y-3">
          {/* Resource Usage */}
          {(service.cpu !== undefined || service.memory !== undefined) && (
            <div>
              <div className="text-xs text-[#9fe6c3]/80 mb-2 flex items-center gap-1">
                <BarChart3 className="h-3 w-3" />
                Resource Usage
              </div>
              <div className="grid grid-cols-2 gap-3">
                {service.cpu !== undefined && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-[#9fe6c3]/70">CPU</span>
                      <span className="text-[#e6ffee]">{service.cpu.toFixed(1)}%</span>
                    </div>
                    <div className="h-1.5 bg-[#1a2a2f] rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-gradient-to-r from-green-400 to-green-500 transition-all duration-300"
                        style={{ width: `${Math.min(service.cpu, 100)}%` }}
                      />
                    </div>
                  </div>
                )}
                {service.memory !== undefined && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-[#9fe6c3]/70">Memory</span>
                      <span className="text-[#e6ffee]">{fmtB(service.memory)}</span>
                    </div>
                    <div className="h-1.5 bg-[#1a2a2f] rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-gradient-to-r from-blue-400 to-blue-500 transition-all duration-300"
                        style={{ width: `${Math.min((service.memory / (1024 * 1024 * 100)) * 100, 100)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Process Information */}
          {(service.pid || service.user) && (
            <div>
              <div className="text-xs text-[#9fe6c3]/80 mb-2 flex items-center gap-1">
                <Zap className="h-3 w-3" />
                Process Info
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                {service.pid && (
                  <div>
                    <span className="text-[#9fe6c3]/70">PID:</span>
                    <span className="ml-2 text-[#e6ffee] font-mono">{service.pid}</span>
                  </div>
                )}
                {service.user && (
                  <div>
                    <span className="text-[#9fe6c3]/70">User:</span>
                    <span className="ml-2 text-[#e6ffee] font-mono">{service.user}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Extended Actions */}
          <div>
            <div className="text-xs text-[#9fe6c3]/80 mb-2 flex items-center gap-1">
              <Settings className="h-3 w-3" />
              Actions
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs border-[#1a2a2f] text-[#9fe6c3] hover:bg-[#10201a]"
                onClick={() => onViewLogs(service.service)}
                disabled={disabled}
              >
                <FileText className="h-3 w-3 mr-1" />
                View Logs
              </Button>
              {service.status === 'running' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs border-[#1a2a2f] text-amber-400 hover:bg-amber-400/10"
                  onClick={() => onRestart(service.service)}
                  disabled={disabled}
                >
                  <RotateCw className="h-3 w-3 mr-1" />
                  Restart
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs border-[#1a2a2f] text-[#9fe6c3] hover:bg-[#10201a]"
                disabled={disabled}
                title="Service configuration (coming soon)"
              >
                <Settings className="h-3 w-3 mr-1" />
                Configure
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ServicesPanel({
  data, 
  onRestart, 
  onStart, 
  onStop, 
  onViewLogs, 
  disabled
}: {
  data: ServicesResponse | null; 
  onRestart: (name: string) => void;
  onStart: (name: string) => void;
  onStop: (name: string) => void;
  onViewLogs: (name: string) => void;
  disabled?: boolean;
}) {
  const entries = Object.entries(data?.services ?? {});
  
  return (
    <Card className="bg-[#0f1416] border-[#1a2a2f]">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-[#9fe6c3] flex items-center gap-2">
          Services
          <Badge variant="outline" className="text-xs border-[#1a2a2f] text-[#9fe6c3]/70">
            {entries.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-3">
          {entries.map(([key, service]) => (
            <ServiceCard
              key={key}
              service={service}
              onRestart={onRestart}
              onStart={onStart}
              onStop={onStop}
              onViewLogs={onViewLogs}
              disabled={disabled}
            />
          ))}
          {entries.length === 0 && (
            <div className="text-center py-8 text-[#9fe6c3]/50">
              No services found
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ContainersTable({data, onRestart, disabled}:{data:ContainersResponse|null; onRestart:(name:string)=>void; disabled?:boolean}){
  return (
    <Card className="bg-[#0f1416] border-[#1a2a2f]">
      <CardHeader className="pb-2"><CardTitle className="text-sm text-[#9fe6c3]">Docker Containers</CardTitle></CardHeader>
      <CardContent className="pt-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[#9fe6c3] text-left">
            <tr>
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Image</th>
              <th className="py-2 pr-4 font-medium">State</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="text-[#e6ffee]">
            {data?.containers?.map((c) => (
              <tr key={c.id} className="border-t border-[#1a2a2f]">
                <td className="py-2 pr-4 font-mono">{c.name}</td>
                <td className="py-2 pr-4">{c.image}</td>
                <td className="py-2 pr-4"><Badge variant="outline" className={c.state==='running'?"border-green-500/60 text-green-300":"border-amber-500/60 text-amber-300"}>{c.state}</Badge></td>
                <td className="py-2 pr-4 text-[#9fe6c3]/80">{c.status}</td>
                <td className="py-2 pr-4"><Button size="sm" disabled={!!disabled} variant="outline" className="border-[#1a2a2f] text-[#9fe6c3] hover:bg-[#10201a] disabled:opacity-50" onClick={()=>onRestart(c.name)}><RefreshCw className="mr-1 h-3 w-3"/> Restart</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function AppsPanel({data}:{data:ApplicationsResponse|null}){
  const apps = Object.values(data?.applications ?? {});
  return (
    <Card className="bg[#0f1416] border-[#1a2a2f] bg-[#0f1416]">
      <CardHeader className="pb-2"><CardTitle className="text-sm text-[#9fe6c3]">Applications</CardTitle></CardHeader>
      <CardContent className="pt-0 grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
        {apps.map((a) => (
          <a key={a.name} href={a.url} target="_blank" rel="noreferrer" className="rounded-lg border border-[#1a2a2f] bg-[#0e1315] p-3 hover:border-[#214b3b]">
            <div className="flex items-center justify-between">
              <div className="text-sm text-[#e6ffee] font-mono">{a.name}</div>
              <Dot status={a.healthy? 'ok' : 'crit'}/>
            </div>
            <div className="mt-1 text-xs text-[#9fe6c3]/80">{a.status_code ?? '—'} • {a.response_time ? `${a.response_time.toFixed(2)}s` : '—'}</div>
            {a.error && <div className="mt-1 text-xs text-amber-300/80">{a.error}</div>}
          </a>
        ))}
      </CardContent>
    </Card>
  );
}

function RealtimeChart({points}:{points:Array<{t:number; cpu:number; mem:number; disk:number; load:number}>}){
  return (
    <Card className="bg-[#0f1416] border-[#1a2a2f]">
      <CardHeader className="pb-2"><CardTitle className="text-sm text-[#9fe6c3]">Real‑Time Metrics</CardTitle></CardHeader>
      <CardContent className="pt-0 h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{left:16,right:16,top:8,bottom:8}}>
            <CartesianGrid stroke="#182428" strokeDasharray="3 3" />
            <XAxis dataKey="t" tickFormatter={()=>''} stroke="#5fae8a"/>
            <YAxis stroke="#5fae8a"/>
            <Tooltip contentStyle={{background:'#0f1416', border:'1px solid #1a2a2f', color:'#e6ffee'}}/>
            <Line type="monotone" dataKey="cpu" dot={false} stroke="#00ff9c" strokeWidth={1.5} name="CPU %"/>
            <Line type="monotone" dataKey="mem" dot={false} stroke="#63ffc8" strokeWidth={1.2} name="Mem %"/>
            <Line type="monotone" dataKey="disk" dot={false} stroke="#38b388" strokeWidth={1.2} name="Disk %"/>
            <Line type="monotone" dataKey="load" dot={false} stroke="#7bdba9" strokeWidth={1.2} name="Load1"/>
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function HistoricalArea({history}:{history:HistoryResponse|null}){
  const data = (history?.metrics ?? []).map(m => ({ t: new Date(m.timestamp*1000).toLocaleString(), cpu: m.cpu_usage, mem: m.memory_usage, disk: m.disk_usage }));
  return (
    <Card className="bg-[#0f1416] border-[#1a2a2f]">
      <CardHeader className="pb-2"><CardTitle className="text-sm text-[#9fe6c3]">7‑Day Trends</CardTitle></CardHeader>
      <CardContent className="pt-0 h-56">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{left:16,right:16,top:8,bottom:8}}>
            <CartesianGrid stroke="#182428" strokeDasharray="3 3" />
            <XAxis dataKey="t" stroke="#5fae8a"/>
            <YAxis stroke="#5fae8a"/>
            <Tooltip contentStyle={{background:'#0f1416', border:'1px solid #1a2a2f', color:'#e6ffee'}}/>
            <Area type="monotone" dataKey="cpu" fill="#0a2a1e" stroke="#00ff9c" name="CPU %"/>
            <Area type="monotone" dataKey="mem" fill="#0e3a2b" stroke="#63ffc8" name="Mem %"/>
            <Area type="monotone" dataKey="disk" fill="#144336" stroke="#38b388" name="Disk %"/>
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function SecurityPanel({data}:{data:SecurityResponse|null}){
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Card className="bg-[#0f1416] border-[#1a2a2f] lg:col-span-2">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-[#9fe6c3]">Active SSH Sessions</CardTitle></CardHeader>
        <CardContent className="pt-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[#9fe6c3] text-left">
              <tr><th className="py-2 pr-4 font-medium">User</th><th className="py-2 pr-4 font-medium">TTY</th><th className="py-2 pr-4 font-medium">IP</th><th className="py-2 pr-4 font-medium">Login</th></tr>
            </thead>
            <tbody className="text-[#e6ffee]">
              {data?.active_sessions?.map((s,i)=> (
                <tr key={i} className="border-t border-[#1a2a2f]"><td className="py-2 pr-4 font-mono">{s.user}</td><td className="py-2 pr-4">{s.terminal}</td><td className="py-2 pr-4">{s.ip ?? '—'}</td><td className="py-2 pr-4 text-[#9fe6c3]/80">{s.login_time}</td></tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <Card className="bg-[#0f1416] border-[#1a2a2f]">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-[#9fe6c3]">Firewall</CardTitle></CardHeader>
        <CardContent className="pt-0 text-sm">
          <div className="flex items-center gap-2"><ShieldHalf size={16}/><span className="text-[#e6ffee]">{data?.firewall?.enabled? 'Enabled' : 'Disabled'}</span></div>
          <div className="mt-1 text-[#9fe6c3]/80">in: {data?.firewall?.default_incoming} • out: {data?.firewall?.default_outgoing}</div>
          <Separator className="my-2 bg-[#1a2a2f]"/>
          <div className="max-h-40 overflow-auto pr-2">
            {(data?.firewall?.rules ?? []).map((r, i) => (
              <div key={i} className="font-mono text-xs text-[#9fe6c3]/80">{r}</div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card className="bg-[#0f1416] border-[#1a2a2f] lg:col-span-3">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-[#9fe6c3]">Failed Login Attempts (recent)</CardTitle></CardHeader>
        <CardContent className="pt-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[#9fe6c3] text-left"><tr><th className="py-2 pr-4 font-medium">Time</th><th className="py-2 pr-4 font-medium">User</th><th className="py-2 pr-4 font-medium">IP</th><th className="py-2 pr-4 font-medium">Status</th><th className="py-2 pr-4 font-medium">Raw</th></tr></thead>
            <tbody className="text-[#e6ffee]">
              {(data?.failed_logins?.recent_attempts ?? []).map((a,i)=> (
                <tr key={i} className="border-t border-[#1a2a2f]">
                  <td className="py-2 pr-4 text-[#9fe6c3]/80">{a.timestamp}</td>
                  <td className="py-2 pr-4">{a.user ?? '—'}</td>
                  <td className="py-2 pr-4">{a.ip ?? '—'}</td>
                  <td className="py-2 pr-4">{a.success? <Badge className="bg-emerald-900/50 text-emerald-300 border-emerald-600/40">success</Badge>: <Badge className="bg-red-900/40 text-red-300 border-red-600/40">failed</Badge>}</td>
                  <td className="py-2 pr-4 text-xs text-[#9fe6c3]/80 font-mono">{a.raw_line}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- Confirmation Dialog ----------
interface ConfirmationDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmText?: string;
  confirmVariant?: 'default' | 'destructive';
  loading?: boolean;
}

function ConfirmationDialog({ 
  open, 
  onClose, 
  onConfirm, 
  title, 
  description, 
  confirmText = 'Confirm', 
  confirmVariant = 'default',
  loading = false 
}: ConfirmationDialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl border border-[#1a2a2f] bg-[#0f1416] shadow-xl">
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className={`p-2 rounded-full ${confirmVariant === 'destructive' ? 'bg-red-400/10' : 'bg-amber-400/10'}`}>
              <AlertTriangle className={`h-5 w-5 ${confirmVariant === 'destructive' ? 'text-red-400' : 'text-amber-400'}`} />
            </div>
            <h2 className="text-lg font-semibold text-[#e6ffee]">{title}</h2>
          </div>
          
          <p className="text-[#9fe6c3]/80 mb-6 leading-relaxed">{description}</p>
          
          <div className="flex gap-3 justify-end">
            <Button
              variant="outline"
              onClick={onClose}
              disabled={loading}
              className="border-[#1a2a2f] text-[#9fe6c3] hover:bg-[#10201a]"
            >
              Cancel
            </Button>
            <Button
              onClick={onConfirm}
              disabled={loading}
              variant={confirmVariant === 'destructive' ? 'destructive' : 'default'}
              className={confirmVariant === 'destructive' ? 
                'bg-red-600 hover:bg-red-700 text-white' : 
                'bg-[#00ff9c] hover:bg-[#0bd47a] text-[#0b0f10]'
              }
            >
              {loading && <RefreshCw className="h-3 w-3 mr-2 animate-spin" />}
              {confirmText}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Service Log Viewer Modal ----------
interface ServiceLogViewerProps {
  serviceName: string | null;
  onClose: () => void;
}

function ServiceLogViewer({ serviceName, onClose }: ServiceLogViewerProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [following, setFollowing] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const logsEndRef = useRef<HTMLDivElement>(null);
  const abortController = useRef<AbortController | null>(null);

  const scrollToBottom = () => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (following) {
      scrollToBottom();
    }
  }, [logs, following]);

  useEffect(() => {
    if (!serviceName) return;

    const fetchLogs = async () => {
      setLoading(true);
      setLogs([]);
      
      try {
        abortController.current = new AbortController();
        const response = await fetch(`${BASE}/api/services/${serviceName}/logs?lines=100`, {
          signal: abortController.current.signal
        });
        
        if (!response.ok) {
          throw new Error(`Failed to fetch logs: ${response.statusText}`);
        }
        
        const data = await response.json();
        setLogs(data.logs || [`No logs available for ${serviceName}`]);
      } catch (error: any) {
        if (error.name !== 'AbortError') {
          console.error('Error fetching logs:', error);
          setLogs([`Error fetching logs: ${error.message}`]);
        }
      } finally {
        setLoading(false);
      }
    };

    fetchLogs();

    return () => {
      abortController.current?.abort();
    };
  }, [serviceName]);

  // Simulate real-time log updates (in a real implementation, this would be via WebSocket)
  useEffect(() => {
    if (!serviceName || !following) return;

    const interval = setInterval(async () => {
      try {
        const response = await fetch(`${BASE}/api/services/${serviceName}/logs?lines=10&since=1m`);
        if (response.ok) {
          const data = await response.json();
          if (data.logs && data.logs.length > 0) {
            setLogs(prev => [...prev, ...data.logs].slice(-1000)); // Keep last 1000 lines
          }
        }
      } catch (error) {
        // Silently fail for real-time updates
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [serviceName, following]);

  const filteredLogs = useMemo(() => {
    if (!searchTerm) return logs;
    return logs.filter(log => 
      log.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [logs, searchTerm]);

  const downloadLogs = () => {
    const content = logs.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${serviceName}-logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!serviceName) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-6xl max-h-[90vh] rounded-xl border border-[#1a2a2f] bg-[#0f1416] shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1a2a2f]">
          <div className="flex items-center gap-3">
            <FileText className="h-5 w-5 text-[#00ff9c]" />
            <div>
              <h2 className="text-lg font-medium text-[#e6ffee]">Service Logs</h2>
              <p className="text-sm text-[#9fe6c3]/70">{serviceName}</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="border-[#1a2a2f] text-[#9fe6c3] hover:bg-[#10201a]"
              onClick={downloadLogs}
              disabled={logs.length === 0}
            >
              <Activity className="h-3 w-3 mr-2" />
              Export
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              <X className="h-4 w-4 text-[#9fe6c3]" />
            </Button>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-4 px-6 py-3 border-b border-[#1a2a2f] bg-[#0e1315]">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#9fe6c3]/50" />
            <input
              type="text"
              placeholder="Search logs..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-[#0f1416] border border-[#1a2a2f] rounded-md text-sm text-[#e6ffee] placeholder:text-[#9fe6c3]/50 focus:outline-none focus:ring-2 focus:ring-[#00ff9c]/20 focus:border-[#00ff9c]/30"
            />
          </div>
          
          <Button
            size="sm"
            variant="outline"
            className={`border-[#1a2a2f] ${following ? 'bg-[#00ff9c]/10 text-[#00ff9c] border-[#00ff9c]/30' : 'text-[#9fe6c3] hover:bg-[#10201a]'}`}
            onClick={() => setFollowing(!following)}
          >
            {following ? 'Following' : 'Follow'}
          </Button>

          <Button
            size="sm"
            variant="outline"
            className="border-[#1a2a2f] text-[#9fe6c3] hover:bg-[#10201a]"
            onClick={() => {
              setLogs([]);
              // Refetch logs
              if (serviceName) {
                fetch(`${BASE}/api/services/${serviceName}/logs?lines=100`)
                  .then(res => res.json())
                  .then(data => setLogs(data.logs || []));
              }
            }}
          >
            <RefreshCw className="h-3 w-3 mr-2" />
            Refresh
          </Button>
        </div>

        {/* Logs Content */}
        <div className="flex-1 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-40 text-[#9fe6c3]/70">
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              Loading logs...
            </div>
          ) : (
            <div className="h-full overflow-auto font-mono text-xs bg-[#0b0f10] p-4">
              {filteredLogs.length > 0 ? (
                <div className="space-y-1">
                  {filteredLogs.map((log, index) => (
                    <div
                      key={index}
                      className="text-[#e6ffee]/90 hover:bg-[#1a2a2f]/30 px-2 py-1 rounded whitespace-pre-wrap break-all"
                    >
                      {log}
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-[#9fe6c3]/50">
                  {searchTerm ? `No logs matching "${searchTerm}"` : 'No logs available'}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-[#1a2a2f] bg-[#0e1315] text-xs text-[#9fe6c3]/70">
          Showing {filteredLogs.length} lines
          {searchTerm && ` (filtered from ${logs.length})`}
          {following && (
            <span className="ml-4 text-[#00ff9c]">● Live</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Issue Detail Modal ----------
function IssueModal({issue, onClose, history}:{issue:DiagnosticIssue|null; onClose:()=>void; history:HistoryResponse|null}){
  if (!issue) return null;
  const relatedAlerts = (history?.alerts ?? []).filter(a => a.category === issue.category).slice(-20);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose}/>
      <div className="relative w-[min(720px,95vw)] max-h-[85vh] overflow-hidden rounded-xl border border-[#1a2a2f] bg-[#0f1416] shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1a2a2f]">
          <div className="flex items-center gap-2">
            <Dot status={issue.severity==='critical'?'crit':issue.severity==='warning'?'warn':'idle'}/>
            <div className="font-mono text-[#e6ffee]">{issue.title}</div>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose}><X className="h-4 w-4 text-[#9fe6c3]"/></Button>
        </div>
        <div className="p-4 grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-[#9fe6c3]/70">Description</div>
            <div className="text-sm text-[#e6ffee]">{issue.description}</div>
            <div className="text-xs uppercase tracking-wide text-[#9fe6c3]/70 mt-3">Resolution</div>
            <div className="text-sm text-[#9fe6c3]">{issue.resolution}</div>
          </div>
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-[#9fe6c3]/70">Related Events (last 20)</div>
            <div className="rounded border border-[#1a2a2f] bg-[#0e1315] max-h-56 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[#0e1315] text-left text-[#9fe6c3]"><tr><th className="px-2 py-1">Time</th><th className="px-2 py-1">Severity</th><th className="px-2 py-1">Message</th></tr></thead>
                <tbody className="text-[#e6ffee]">
                  {relatedAlerts.map((a,i)=> (
                    <tr key={i} className="border-t border-[#1a2a2f]"><td className="px-2 py-1 text-[#9fe6c3]/80">{new Date(a.timestamp*1000).toLocaleString()}</td><td className="px-2 py-1">{a.severity}</td><td className="px-2 py-1">{a.message}</td></tr>
                  ))}
                  {relatedAlerts.length===0 && <tr><td className="px-2 py-2 text-[#9fe6c3]/70" colSpan={3}>No related events.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div className="px-4 pb-4 flex items-center justify-end gap-2">
          {issue.can_auto_resolve && <Button className="bg-emerald-800/50 hover:bg-emerald-800/70 border border-emerald-700/40" onClick={()=>{
            // Will be handled by parent via custom event
            const evt = new CustomEvent('resolve-issue', { detail: { id: issue.id } });
            window.dispatchEvent(evt);
          }}><Bug className="h-4 w-4 mr-2"/>Auto‑resolve</Button>}
          <Button variant="outline" className="border-[#1a2a2f] text-[#9fe6c3] hover:bg-[#10201a]" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

function DiagnosticsPanel({data, onResolve, onOpen}:{data:DiagnosticsResponse|null; onResolve:(id:string)=>void; onOpen:(issue:DiagnosticIssue)=>void}){
  return (
    <Card className="bg-[#0f1416] border-[#1a2a2f]">
      <CardHeader className="pb-2"><CardTitle className="text-sm text-[#9fe6c3]">Current Issues</CardTitle></CardHeader>
      <CardContent className="pt-0 space-y-2">
        {(data?.issues ?? []).map((iss)=>{
          const tone = iss.severity === 'critical' ? 'crit' : iss.severity==='warning' ? 'warn' : 'idle';
          return (
            <div key={iss.id} className="rounded-lg border border-[#1a2a2f] bg-[#0e1315] p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Dot status={tone as any}/>
                  <button className="text-sm text-[#e6ffee] hover:underline text-left" onClick={()=>onOpen(iss)} title="View details">{iss.title}</button>
                </div>
                <div className="text-xs text-[#9fe6c3]/80">{iss.category}</div>
              </div>
              <div className="mt-1 text-xs text-[#9fe6c3]/80 line-clamp-2">{iss.description}</div>
              <div className="mt-2 flex items-center gap-2">
                {iss.can_auto_resolve && <Button size="sm" variant="outline" className="border-[#1a2a2f] text-[#9fe6c3] hover:bg-[#10201a]" onClick={()=>onResolve(iss.id)}><Bug className="h-3 w-3 mr-1"/> Auto‑resolve</Button>}
                <Button size="sm" className="bg-[#113a2d] hover:bg-[#144436] border border-[#1a2a2f]" onClick={()=>onOpen(iss)}>Details</Button>
              </div>
            </div>
          );
        })}
        {(!data || data.issues.length===0) && <div className="text-sm text-[#9fe6c3]/70">No issues. You earned a coffee.</div>}
      </CardContent>
    </Card>
  );
}

// -------------------------------------------------------------
// Actions
// -------------------------------------------------------------
async function postJSON<T>(path:string, body:any){
  const res = await fetch(`${BASE}${path}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const json = await res.json();
  if(!res.ok) throw new Error(json?.message || res.statusText);
  return json as T;
}

// -------------------------------------------------------------
// God‑Mode Command Palette (🔻 Cmd/Ctrl‑K)
// -------------------------------------------------------------
interface CommandItem { id:string; label:string; hint?:string; action:()=>void; group:string }
function useHotkey(combo:string, handler:(e:KeyboardEvent)=>void){
  useEffect(()=>{
    const f = (e:KeyboardEvent)=>{
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const want = combo.toLowerCase();
      const got = `${(isMac?e.metaKey:e.ctrlKey)?'ctrlk':''}${e.key.toLowerCase()}`;
      if (want==='cmdk' && ((isMac && e.metaKey && e.key.toLowerCase()==='k') || (!isMac && e.ctrlKey && e.key.toLowerCase()==='k'))){ e.preventDefault(); handler(e); }
    };
    window.addEventListener('keydown', f);
    return ()=>window.removeEventListener('keydown', f);
  }, [combo, handler]);
}

function CommandPalette({open, setOpen, items}:{open:boolean; setOpen:(v:boolean)=>void; items:CommandItem[]}){
  const [q, setQ] = useState("");
  const filtered = useMemo(()=>{
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter(x => x.label.toLowerCase().includes(s) || (x.hint?.toLowerCase().includes(s)));
  }, [q, items]);

  useEffect(()=>{
    const onEsc = (e:KeyboardEvent)=>{ if (e.key==='Escape') setOpen(false); };
    if (open) window.addEventListener('keydown', onEsc);
    return ()=>window.removeEventListener('keydown', onEsc);
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={()=>setOpen(false)} />
      <div className="absolute left-1/2 top-24 -translate-x-1/2 w-[min(720px,95vw)] rounded-xl border border-[#1a2a2f] bg-[#0f1416] shadow-xl">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[#1a2a2f]">
          <Search className="h-4 w-4 text-[#9fe6c3]"/>
          <input autoFocus value={q} onChange={e=>setQ(e.target.value)} placeholder="Type to search… e.g., restart nginx, goto diagnostics, resolve issue-42" className="w-full bg-transparent outline-none text-sm text-[#e6ffee] placeholder:text-[#9fe6c3]/50"/>
          <Button variant="ghost" size="icon" onClick={()=>setOpen(false)}><X className="h-4 w-4 text-[#9fe6c3]"/></Button>
        </div>
        <div className="max-h-[60vh] overflow-auto p-2">
          {['Safe Mode','Navigate','Services','Containers','Issues'].map(group => (
            <div key={group}>
              <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-[#9fe6c3]/60">{group}</div>
              {filtered.filter(i=>i.group===group).map(i => (
                <button key={i.id} className="w-full text-left px-3 py-2 rounded-md hover:bg-[#10201a] border border-transparent hover:border-[#1a2a2f] text-sm text-[#e6ffee] flex items-center justify-between" onClick={()=>{i.action(); setOpen(false);}}>
                  <span>{i.label}</span>
                  {i.hint && <span className="text-[10px] text-[#9fe6c3]/60">{i.hint}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// Safe‑Mode (global)
// -------------------------------------------------------------
interface QueueItem { kind: 'service'|'container'; name: string }

function scoreContainer(name:string){
  const n = name.toLowerCase();
  if (/postgres|mysql|mariadb|db/.test(n)) return 1;
  if (/redis|cache/.test(n)) return 2;
  if (/back|api/.test(n)) return 3;
  if (/front|web|nginx/.test(n)) return 4;
  return 5;
}

async function waitForServiceRunning(name:string, timeoutMs=60_000){
  const start = Date.now();
  while (Date.now()-start < timeoutMs){
    try {
      const res = await fetch(`${BASE}/api/services`);
      const data:ServicesResponse = await res.json();
      const s = data.services?.[name] || Object.values(data.services||{}).find(v=>v.service===name);
      if (s && s.status==='running') return true;
    } catch {}
    await sleep(2_000);
  }
  throw new Error(`Timeout waiting for service ${name}`);
}

async function waitForContainerRunning(name:string, timeoutMs=90_000){
  const start = Date.now();
  while (Date.now()-start < timeoutMs){
    try {
      const res = await fetch(`${BASE}/api/containers`);
      const data:ContainersResponse = await res.json();
      const c = (data.containers||[]).find(v=>v.name===name);
      if (c && c.state==='running') return true;
    } catch {}
    await sleep(2_000);
  }
  throw new Error(`Timeout waiting for container ${name}`);
}

function SafeModeBanner(){
  return (
    <div className="w-full bg-[#0b241b] border-b border-[#1a2a2f] text-center text-xs text-[#9fe6c3] py-1">
      <span className="inline-flex items-center gap-2"><ShieldAlert className="h-3 w-3 text-amber-400"/> SAFE‑MODE active: Actions are sequenced & calmer visuals engaged.</span>
    </div>
  );
}

function SafeModeModal({open, onClose, plan, setPlan, running, logs, onStart, onExit}:{open:boolean; onClose:()=>void; plan:QueueItem[]; setPlan:(q:QueueItem[])=>void; running:boolean; logs:string[]; onStart:()=>void; onExit:()=>void}){
  const remove = (idx:number) => setPlan(plan.filter((_,i)=>i!==idx));
  const addRecommended = () => setPlan(prev => {
    const next: QueueItem[] = [];
    // We'll signal to user: db/cache -> containers by heuristic -> nginx last if present
    // Services snapshot will be fetched outside; here we rely on window globals dispatched below (set by parent)
    const svc = (window as any).__svc as ServicesResponse | undefined;
    const ctr = (window as any).__ctr as ContainersResponse | undefined;
    if (svc?.services?.['postgresql']) next.push({kind:'service', name:'postgresql'});
    if (svc?.services?.['redis-server']) next.push({kind:'service', name:'redis-server'});
    (ctr?.containers||[]).slice().sort((a,b)=>scoreContainer(a.name)-scoreContainer(b.name)).forEach(c=> next.push({kind:'container', name:c.name}));
    if (svc?.services?.['nginx']) next.push({kind:'service', name:'nginx'});
    return next;
  });

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={onClose}/>
      <div className="absolute left-1/2 top-20 -translate-x-1/2 w-[min(860px,95vw)] rounded-xl border border-[#1a2a2f] bg-[#0f1416] shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1a2a2f]">
          <div className="flex items-center gap-2 text-[#e6ffee]"><ShieldAlert className="h-4 w-4 text-amber-400"/> Global Safe‑Mode</div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4 text-[#9fe6c3]"/></Button>
          </div>
        </div>
        <div className="grid gap-4 p-4 md:grid-cols-5">
          <div className="md:col-span-2">
            <div className="text-xs uppercase tracking-wider text-[#9fe6c3]/70 mb-2">Plan</div>
            <div className="rounded-md border border-[#1a2a2f] bg-[#0e1315] divide-y divide-[#1a2a2f] max-h-72 overflow-auto">
              {plan.length===0 && <div className="p-3 text-xs text-[#9fe6c3]/70">Empty. Add a recommended plan or queue items below.</div>}
              {plan.map((q, i)=> (
                <div key={`${q.kind}:${q.name}:${i}`} className="flex items-center justify-between px-3 py-2 text-sm text-[#e6ffee]">
                  <span className="font-mono"><Badge variant="outline" className="mr-2 border-[#1a2a2f] text-[#9fe6c3]/80">{q.kind}</Badge>{q.name}</span>
                  <Button size="xs" variant="ghost" onClick={()=>remove(i)}><X className="h-3 w-3 text-[#9fe6c3]"/></Button>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" variant="outline" className="border-[#1a2a2f] text-[#9fe6c3]" onClick={addRecommended}>Populate recommended</Button>
              <Button size="sm" variant="outline" className="border-[#1a2a2f] text-[#9fe6c3]" onClick={()=>setPlan([])}>Clear</Button>
            </div>
            <div className="mt-3 text-xs text-[#9fe6c3]/70">Heuristic order: databases → caches → backends → frontends → edge.</div>
          </div>
          <div className="md:col-span-3">
            <div className="text-xs uppercase tracking-wider text-[#9fe6c3]/70 mb-2">Run / Logs</div>
            <div className="rounded-md border border-[#1a2a2f] bg-[#0e1315] h-56 overflow-auto p-2 font-mono text-xs text-[#9fe6c3]/80">
              {logs.length===0 ? <div>Ready. Start when your plan looks right.</div> : logs.map((l,i)=>(<div key={i}>{l}</div>))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button disabled={running || plan.length===0} className="bg-[#123026] hover:bg-[#15372d] border border-[#1a2a2f]" onClick={onStart}><AlertTriangle className="h-4 w-4 mr-2"/>Start guided safe restart</Button>
              <Button variant="outline" className="border-[#1a2a2f] text-[#9fe6c3]" onClick={onExit}>Exit Safe‑Mode</Button>
            </div>
            <div className="mt-2 text-[11px] text-[#9fe6c3]/60">While running, manual restart buttons are disabled and the UI chills the palette. If your backend exposes a dedicated endpoint (e.g., <code>/api/actions/safe_mode</code>), wire it in and we’ll use it.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// Main App
// -------------------------------------------------------------
export default function SSHSJEDashboard(){
  // polling per schema
  const sys = useApi<SystemResponse>("/api/system", 30);
  const services = useApi<ServicesResponse>("/api/services", 60);
  const containers = useApi<ContainersResponse>("/api/containers", 30);
  const apps = useApi<ApplicationsResponse>("/api/applications", 60);
  const security = useApi<SecurityResponse>("/api/security", 60);
  const diag = useApi<DiagnosticsResponse>("/api/diagnostics", 60);
  const history = useApi<HistoryResponse>("/api/history?days=7", 300);

  // real‑time line buffer
  const [rt, setRt] = useState<Array<{t:number; cpu:number; mem:number; disk:number; load:number}>>([]);
  const maxPoints = 120; // ~1h if WS pushes every 30s

  const onSocket = useCallback((msg:any)=>{
    // contract: { type: 'system_update' | 'alert' | 'container_event', payload: ... }
    if (msg?.type === 'system_update' && msg.payload) {
      const p = msg.payload as SystemResponse;
      const diskRoot = p.disk?.["/"] ?? Object.values(p.disk ?? {})[0];
      setRt(prev => {
        const next = [...prev, { t: Date.now(), cpu: p.cpu_usage, mem: p.memory?.percent ?? 0, disk: diskRoot?.percent ?? 0, load: p.load_average?.load1 ?? 0 }];
        return next.slice(-maxPoints);
      });
      sys.refetch();
    }
    if (msg?.type === 'alert') {
      const a = msg.payload; // {severity,title,message}
      toast.message(a?.title ?? 'Alert', { description: a?.message });
    }
    if (msg?.type === 'container_event') { containers.refetch(); }
  }, []);

  useAgentSocket(onSocket, true);


  const handleRestartContainer = async (name:string) => {
    try { await postJSON("/api/actions/restart", { type: "container", name }); toast.success(`Restarted container ${name}`); containers.refetch(); }
    catch(e:any){ toast.error(e.message ?? 'Restart failed'); }
  };
  const handleRestartService = async (name:string) => {
    try { await postJSON("/api/actions/restart", { type: "service", name }); toast.success(`Restarted service ${name}`); services.refetch(); }
    catch(e:any){ toast.error(e.message ?? 'Restart failed'); }
  };
  
  const handleStartService = async (name:string) => {
    try { await postJSON("/api/actions/start", { type: "service", name }); toast.success(`Started service ${name}`); services.refetch(); }
    catch(e:any){ toast.error(e.message ?? 'Start failed'); }
  };
  
  const handleStopService = async (name:string) => {
    try { await postJSON("/api/actions/stop", { type: "service", name }); toast.success(`Stopped service ${name}`); services.refetch(); }
    catch(e:any){ toast.error(e.message ?? 'Stop failed'); }
  };
  
  // Wrapper functions with confirmation dialogs
  const confirmRestartService = (name: string) => {
    setConfirmDialog({
      open: true,
      title: 'Restart Service',
      description: `Are you sure you want to restart the "${name}" service? This may cause temporary downtime.`,
      confirmText: 'Restart',
      confirmVariant: 'default',
      loading: false,
      onConfirm: async () => {
        setConfirmDialog(prev => ({ ...prev, loading: true }));
        try {
          await handleRestartService(name);
          setConfirmDialog(prev => ({ ...prev, open: false, loading: false }));
        } catch (error) {
          setConfirmDialog(prev => ({ ...prev, loading: false }));
        }
      }
    });
  };
  
  const confirmStopService = (name: string) => {
    setConfirmDialog({
      open: true,
      title: 'Stop Service',
      description: `Are you sure you want to stop the "${name}" service? This will make the service unavailable until manually started.`,
      confirmText: 'Stop',
      confirmVariant: 'destructive',
      loading: false,
      onConfirm: async () => {
        setConfirmDialog(prev => ({ ...prev, loading: true }));
        try {
          await handleStopService(name);
          setConfirmDialog(prev => ({ ...prev, open: false, loading: false }));
        } catch (error) {
          setConfirmDialog(prev => ({ ...prev, loading: false }));
        }
      }
    });
  };
  
  const confirmStartService = (name: string) => {
    setConfirmDialog({
      open: true,
      title: 'Start Service',
      description: `Are you sure you want to start the "${name}" service?`,
      confirmText: 'Start',
      confirmVariant: 'default',
      loading: false,
      onConfirm: async () => {
        setConfirmDialog(prev => ({ ...prev, loading: true }));
        try {
          await handleStartService(name);
          setConfirmDialog(prev => ({ ...prev, open: false, loading: false }));
        } catch (error) {
          setConfirmDialog(prev => ({ ...prev, loading: false }));
        }
      }
    });
  };
  
  const handleResolve = async (id:string) => {
    try { await postJSON("/api/actions/resolve", { issue_id: id }); toast.success(`Resolved ${id}`); diag.refetch(); }
    catch(e:any){ toast.error(e.message ?? 'Resolve failed'); }
  };

  // Issue modal
  const [openIssue, setOpenIssue] = useState<DiagnosticIssue|null>(null);
  
  // Service log viewer
  const [logViewerService, setLogViewerService] = useState<string | null>(null);
  
  // Confirmation dialog
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    confirmText: string;
    confirmVariant: 'default' | 'destructive';
    onConfirm: () => void;
    loading: boolean;
  }>({
    open: false,
    title: '',
    description: '',
    confirmText: 'Confirm',
    confirmVariant: 'default',
    onConfirm: () => {},
    loading: false
  });
  useEffect(()=>{
    const onResolveEvt = (e:any)=>{ if (e?.detail?.id) handleResolve(e.detail.id); };
    window.addEventListener('resolve-issue', onResolveEvt as any);
    return ()=>window.removeEventListener('resolve-issue', onResolveEvt as any);
  }, []);

  // Sections refs for navigation
  const refDashboard = useRef<HTMLDivElement|null>(null);
  const refMonitoring = useRef<HTMLDivElement|null>(null);
  const refSecurity = useRef<HTMLDivElement|null>(null);
  const refDiagnostics = useRef<HTMLDivElement|null>(null);

  // ---------- Safe‑Mode state ----------
  const [safeActive, setSafeActive] = useState(false);
  const [safeOpen, setSafeOpen] = useState(false);
  const [plan, setPlan] = useState<QueueItem[]>([]);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  // Keep latest snapshots globally (used by modal's recommended plan)
  useEffect(()=>{ (window as any).__svc = services.data; }, [services.data]);
  useEffect(()=>{ (window as any).__ctr = containers.data; }, [containers.data]);

  async function startGuided(){
    setRunning(true);
    setLogs([]);
    try {
      // Try to call backend safe mode endpoint if it exists
      try {
        await postJSON("/api/actions/safe_mode", { mode: 'enter', reason: 'guided-restart' });
        setLogs(l=>[...l, `[agent] acknowledged safe_mode: enter`]);
      } catch { setLogs(l=>[...l, `[agent] dedicated safe_mode endpoint not available — proceeding with client‑side sequence`] ); }

      // Sequence
      for (let i=0;i<plan.length;i++){
        const item = plan[i];
        setLogs(l=>[...l, `▶ Step ${i+1}/${plan.length}: restart ${item.kind} ${item.name}`]);
        if (item.kind==='service') {
          await postJSON("/api/actions/restart", { type:'service', name: item.name });
          setLogs(l=>[...l, `… waiting for service ${item.name} to be running`]);
          await waitForServiceRunning(item.name);
        } else {
          await postJSON("/api/actions/restart", { type:'container', name: item.name });
          setLogs(l=>[...l, `… waiting for container ${item.name} to be running`]);
          await waitForContainerRunning(item.name);
        }
        setLogs(l=>[...l, `✓ ${item.kind} ${item.name} is running`]);
      }
      setLogs(l=>[...l, `✔ Guided safe restart completed`]);
    } catch (e:any) {
      setLogs(l=>[...l, `✖ Error: ${e?.message || e}`]);
      toast.error(e?.message || 'Safe‑mode step failed');
    } finally {
      // Try to exit backend safe mode if we entered it
      try { await postJSON("/api/actions/safe_mode", { mode: 'exit' }); setLogs(l=>[...l, `[agent] safe_mode: exit`]); } catch {}
      setRunning(false);
    }
  }

  // Command palette
  const [cmdOpen, setCmdOpen] = useState(false);
  useHotkey('cmdk', () => setCmdOpen(v=>!v));
  const items: CommandItem[] = useMemo(()=>{
    const list: CommandItem[] = [];
    // Safe Mode
    list.push({ id:'safe:open', label: safeActive? 'Open Safe‑Mode panel' : 'Enter Safe‑Mode', group:'Safe Mode', action:()=>{ setSafeActive(true); setSafeOpen(true);} });
    if (safeActive) list.push({ id:'safe:exit', label:'Exit Safe‑Mode', group:'Safe Mode', action:()=>setSafeActive(false) });
    if (safeActive) list.push({ id:'safe:start', label:'Start guided safe restart', group:'Safe Mode', action:()=>{ setSafeOpen(true); } });

    // Navigate
    list.push({ id:'nav:dashboard', label:'Go to Dashboard', group:'Navigate', action:()=>refDashboard.current?.scrollIntoView({behavior:'smooth'}) });
    list.push({ id:'nav:monitoring', label:'Go to Monitoring', group:'Navigate', action:()=>refMonitoring.current?.scrollIntoView({behavior:'smooth'}) });
    list.push({ id:'nav:security', label:'Go to Security', group:'Navigate', action:()=>refSecurity.current?.scrollIntoView({behavior:'smooth'}) });
    list.push({ id:'nav:diagnostics', label:'Go to Diagnostics', group:'Navigate', action:()=>refDiagnostics.current?.scrollIntoView({behavior:'smooth'}) });
    // Services
    Object.values(services.data?.services ?? {}).forEach(s => list.push({ id:`svc:${s.service}`, label:`Restart service ${s.service}`, hint:s.status, group:'Services', action:()=>handleRestartService(s.service) }));
    // Containers
    (containers.data?.containers ?? []).forEach(c => list.push({ id:`ctr:${c.name}`, label:`Restart container ${c.name}`, hint:c.state, group:'Containers', action:()=>handleRestartContainer(c.name) }));
    // Issues
    (diag.data?.issues ?? []).forEach(i => list.push({ id:`iss:${i.id}`, label:`Resolve ${i.title}`, hint:i.severity, group:'Issues', action:()=>handleResolve(i.id) }));
    return list;
  }, [services.data, containers.data, diag.data, safeActive]);

  // Header buttons disabled state when running
  const actionsDisabled = running;

  return (
    <div style={{background: theme.bg}} className={`min-h-screen text-[#e6ffee] ${safeActive? 'safemode' : ''}`}>
      <CRTOverlay/>
      {/* Header */}
      <header className="sticky top-0 z-10 backdrop-blur supports-[backdrop-filter]:bg-[#0b0f10]/70 border-b border-[#1a2a2f]">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded bg-[#123026] border border-[#1a2a2f]"><Terminal size={14} color={theme.neon}/></span>
            <GlitchTitle>sshsshje // monitor</GlitchTitle>
            <span className="ml-3 text-xs text-[#9fe6c3]/70 font-mono">{sys.data ? `t+${since(sys.data.timestamp)}` : 'syncing'}</span>
            {safeActive && <span className="ml-3 inline-flex items-center gap-1 text-xs text-amber-300"><ShieldAlert className="h-3 w-3"/> SAFE</span>}
          </div>
          <div className="flex items-center gap-3">
            <Button variant={safeActive? 'default' : 'outline'} className={`${safeActive? 'bg-amber-800/40 hover:bg-amber-800/60' : 'border-[#1a2a2f] text-[#9fe6c3] hover:bg-[#10201a]'}`} onClick={()=>{ setSafeActive(true); setSafeOpen(true); }}>
              <ShieldAlert className="h-3 w-3 mr-2"/> Safe‑Mode
            </Button>
            <div className="hidden sm:flex items-center gap-2 text-xs text-[#9fe6c3]/80"><kbd className="px-1.5 py-0.5 rounded border border-[#1a2a2f] bg-[#0e1315]">⌘/Ctrl</kbd> + <kbd className="px-1.5 py-0.5 rounded border border-[#1a2a2f] bg-[#0e1315]">K</kbd> <span className="ml-1">God‑Mode</span></div>
            <Button variant="outline" className="border-[#1a2a2f] text-[#9fe6c3] hover:bg-[#10201a]" onClick={()=>{ sys.refetch(); services.refetch(); containers.refetch(); apps.refetch(); security.refetch(); diag.refetch(); history.refetch(); }} disabled={actionsDisabled}>
              <RefreshCw className="h-3 w-3 mr-2"/> Refresh
            </Button>
          </div>
        </div>
        {safeActive && <SafeModeBanner/>}
      </header>

      {/* Body */}
      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {/* Dashboard sections */}
        <section ref={refDashboard}>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm uppercase tracking-wider text-[#9fe6c3]/80">Dashboard</h2>
          </div>
          <MetricsGrid sys={sys.data as any}/>
          <div className="grid gap-3 mt-3 lg:grid-cols-2">
            <ServicesPanel 
              data={services.data as any} 
              onRestart={confirmRestartService} 
              onStart={confirmStartService}
              onStop={confirmStopService}
              onViewLogs={setLogViewerService}
              disabled={actionsDisabled}
            />
            <AppsPanel data={apps.data as any}/>
          </div>
          <div className="mt-3">
            <ContainersTable data={containers.data as any} onRestart={handleRestartContainer} disabled={actionsDisabled}/>
          </div>
        </section>

        {/* Monitoring */}
        <section ref={refMonitoring}>
          <h2 className="mb-2 text-sm uppercase tracking-wider text-[#9fe6c3]/80">Monitoring</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            <RealtimeChart points={rt}/>
            <HistoricalArea history={history.data as any}/>
          </div>
        </section>

        {/* Security */}
        <section ref={refSecurity}>
          <h2 className="mb-2 text-sm uppercase tracking-wider text-[#9fe6c3]/80">Security</h2>
          <SecurityPanel data={security.data as any}/>
        </section>

        {/* Diagnostics */}
        <section ref={refDiagnostics}>
          <h2 className="mb-2 text-sm uppercase tracking-wider text-[#9fe6c3]/80">Diagnostics</h2>
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <DiagnosticsPanel data={diag.data as any} onResolve={handleResolve} onOpen={setOpenIssue}/>
            </div>
            <Card className="bg-[#0f1416] border-[#1a2a2f]">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-[#9fe6c3]">System Health Score</CardTitle></CardHeader>
              <CardContent className="pt-0 flex items-center justify-center h-[220px]">
                <div className="relative w-40 h-40">
                  <div className="absolute inset-0 rounded-full" style={{ background: `conic-gradient(${theme.neon} ${(diag.data?.health_score ?? 0)*3.6}deg, #1c2a23 ${(diag.data?.health_score ?? 0)*3.6}deg)` }}/>
                  <div className="absolute inset-3 rounded-full bg-[#0f1416] flex flex-col items-center justify-center">
                    <div className="text-3xl text-[#e6ffee] font-semibold">{Math.round(diag.data?.health_score ?? 0)}</div>
                    <div className="text-xs text-[#9fe6c3]/80 mt-1">/100</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        <footer className="pt-6 text-xs text-[#9fe6c3]/60">
          Schema‑aligned UI • sshsshje • mild Mr‑Robot skin • {new Date().getFullYear()}
        </footer>
      </main>

      {/* Modals */}
      <IssueModal issue={openIssue} onClose={()=>setOpenIssue(null)} history={history.data as any}/>
      <ServiceLogViewer serviceName={logViewerService} onClose={() => setLogViewerService(null)} />
      <ConfirmationDialog
        open={confirmDialog.open}
        onClose={() => setConfirmDialog(prev => ({ ...prev, open: false }))}
        onConfirm={confirmDialog.onConfirm}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        confirmVariant={confirmDialog.confirmVariant}
        loading={confirmDialog.loading}
      />
      <SafeModeModal open={safeOpen} onClose={()=>setSafeOpen(false)} plan={plan} setPlan={setPlan} running={running} logs={logs} onStart={startGuided} onExit={()=>{ setSafeActive(false); setSafeOpen(false); }}/>

      {/* Command Palette */}
      <CommandPalette open={cmdOpen} setOpen={setCmdOpen} items={items}/>

      <style jsx global>{`
        :root { --sub: ${theme.sub}; }
        * { scrollbar-width: thin; scrollbar-color: ${theme.neonDim} #0f1416; }
        ::-webkit-scrollbar { height: 8px; width: 8px; }
        ::-webkit-scrollbar-thumb { background: ${theme.neonDim}55; border-radius: 8px; }
        ::selection { background: ${theme.neon}33; }
        .safemode { filter: saturate(0.85) brightness(0.96); }
      `}</style>
    </div>
  );
}
