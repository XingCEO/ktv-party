/** WebSocket client with auto-reconnect and event subscription. */
export type WsMessage = { event: string; data: any };
export type WsHandler = (msg: WsMessage) => void;
export type ConnectionState = 'connecting' | 'open' | 'closed' | 'reconnecting';
export type StateHandler = (state: ConnectionState, latencyMs: number | null) => void;

export class RoomSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<WsHandler>();
  private stateHandlers = new Set<StateHandler>();
  private reconnectMs = 1000;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private state: ConnectionState = 'closed';
  private latencies: number[] = [];

  constructor(public roomId: string, public baseUrl?: string) {}

  private setState(newState: ConnectionState) {
    if (this.state === newState && newState !== 'open') return;
    this.state = newState;
    const avgLatency = this.latencies.length > 0 
      ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length) 
      : null;
    this.stateHandlers.forEach(h => h(this.state, avgLatency));
  }

  private updateLatency(latency: number) {
    this.latencies.push(latency);
    if (this.latencies.length > 5) this.latencies.shift();
    this.setState(this.state);
  }

  private url(): string {
    if (this.baseUrl) return `${this.baseUrl}/ws/rooms/${this.roomId}`;
    if (typeof window === "undefined") return "";
    // Public-tunnel mode: NEXT_PUBLIC_WS_BASE points at whatever URL fronts the
    // FastAPI server (e.g. a cloudflared tunnel for port 8000). When unset we
    // fall back to LAN-mode by swapping the page port for :8000.
    const envBase = process.env.NEXT_PUBLIC_WS_BASE;
    if (envBase) {
      const base = envBase.replace(/^http/, "ws").replace(/\/$/, "");
      return `${base}/ws/rooms/${this.roomId}`;
    }
    // CRITICAL: under https (cloudflared / ngrok / production tunnel), we must
    // NOT swap to plain :8000 — that's mixed-content and the browser will block
    // the WS connection silently. In https mode, assume the same origin
    // proxies /ws/* to the FastAPI server (operator must set up the rewrite).
    // For LAN-dev (http), the dev script binds API on :8000 so port-swap is safe.
    const isSecure = window.location.protocol === "https:";
    const proto = isSecure ? "wss:" : "ws:";
    const host = isSecure
      ? window.location.host                          // same-origin via reverse proxy
      : window.location.host.replace(/:\d+$/, ":8000"); // LAN dev: swap to API port
    return `${proto}//${host}/ws/rooms/${this.roomId}`;
  }

  connect(): void {
    if (this.closed) return;
    if (typeof window === "undefined") return;
    try {
      this.setState(this.ws ? 'reconnecting' : 'connecting');
      this.ws = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.reconnectMs = 1000;
      this.setState('open');
      this.pingTimer = setInterval(() => this.send("ping", { ts: Date.now() }), 25_000);
    };
    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as WsMessage;
        if (msg.event === 'server.ping') {
          this.send('pong', {});
        } else if (msg.event === 'pong' && msg.data && typeof msg.data.ts === 'number') {
          this.updateLatency(Date.now() - msg.data.ts);
        }
        this.handlers.forEach((h) => h(msg));
      } catch {
        /* ignore */
      }
    };
    this.ws.onclose = () => {
      this.cleanupTimer();
      this.scheduleReconnect();
    };
    this.ws.onerror = () => this.ws?.close();
  }

  private cleanupTimer() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect() {
    if (this.closed) return;
    this.setState('reconnecting');
    const jitter = 0.85 + Math.random() * 0.30;
    const delay = this.reconnectMs * jitter;
    setTimeout(() => this.connect(), delay);
    this.reconnectMs = Math.min(this.reconnectMs * 2, 15_000);
  }

  on(handler: WsHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onState(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    handler(this.state, this.latencies.length ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length) : null);
    return () => this.stateHandlers.delete(handler);
  }

  send(event: string, data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event, data }));
    }
  }

  close(): void {
    this.closed = true;
    this.setState('closed');
    this.cleanupTimer();
    this.ws?.close();
  }
}
