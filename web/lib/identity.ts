/** Local identity stored in localStorage; nickname + uuid persisted per device. */
const KEY = "ktv-identity-v1";

export type Identity = { user_id: string; nickname: string };

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function getIdentity(): Identity | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Identity;
  } catch {
    return null;
  }
}

export function ensureIdentity(nickname: string): Identity {
  const cur = getIdentity();
  if (cur && cur.nickname === nickname) return cur;
  const next: Identity = { user_id: cur?.user_id || uuid(), nickname };
  window.localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function clearIdentity(): void {
  if (typeof window !== "undefined") window.localStorage.removeItem(KEY);
}
