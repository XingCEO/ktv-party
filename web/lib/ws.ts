/** WebSocket client with auto-reconnect and event subscription. */
export type WsMessage = { event: string; data: any };
export type WsHandler = (msg: WsMessage) => void;

export class RoomSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<WsHandler>();
  private reconnectMs = 1000;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(public roomId: string, public baseUrl?: string) {}

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
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    return `${proto}//${host.replace(/:\d+$/, ":8000")}/ws/rooms/${this.roomId}`;
  }

  connect(): void {
    if (this.closed) return;
    if (typeof window === "undefined") return;
    try {
      this.ws = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.reconnectMs = 1000;
      this.pingTimer = setInterval(() => this.send("ping", {}), 25_000);
    };
    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as WsMessage;
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
    setTimeout(() => this.connect(), this.reconnectMs);
    this.reconnectMs = Math.min(this.reconnectMs * 2, 15_000);
  }

  on(handler: WsHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(event: string, data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event, data }));
    }
  }

  close(): void {
    this.closed = true;
    this.cleanupTimer();
    this.ws?.close();
  }
}
