import { useRef, useEffect, useCallback, useState } from 'react';
import { RoomSocket } from './ws';

export function useStableCallback<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef<T>(fn);
  useEffect(() => {
    ref.current = fn;
  }, [fn]);
  // Stable identity by design: empty deps is intentional; the ref always
  // points to the latest fn so consumers (intervals, event listeners) never
  // close over a stale callback.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(((...args: Parameters<T>): ReturnType<T> => {
    return ref.current(...args);
  }) as T, []);
}

export function useDebounceCallback<T extends (...args: any[]) => void>(fn: T, delay: number): T {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stableFn = useStableCallback(fn);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // stableFn has stable identity via useStableCallback, so this useCallback
  // only re-binds when the user changes `delay`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(((...args: Parameters<T>) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      stableFn(...args);
    }, delay);
  }) as T, [delay, stableFn]);
}

export function useInterval(cb: () => void, delayMs: number | null): void {
  const stableCb = useStableCallback(cb);
  useEffect(() => {
    if (delayMs === null) return;
    const id = setInterval(stableCb, delayMs);
    return () => clearInterval(id);
  }, [delayMs, stableCb]);
}

export function useRoomSocket(roomId: string): {
  socket: RoomSocket | null;
  state: 'connecting' | 'open' | 'closed' | 'reconnecting';
  latencyMs: number | null;
} {
  const [socket, setSocket] = useState<RoomSocket | null>(null);
  const [state, setState] = useState<'connecting' | 'open' | 'closed' | 'reconnecting'>('closed');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  useEffect(() => {
    if (!roomId) return;
    const ws = new RoomSocket(roomId);
    setSocket(ws);
    
    const unsubscribe = ws.onState((newState, newLatency) => {
      setState(newState);
      setLatencyMs(newLatency);
    });

    ws.connect();

    return () => {
      unsubscribe();
      ws.close();
      setSocket(null);
    };
  }, [roomId]);

  return { socket, state, latencyMs };
}
