/** Local identity stored in localStorage; nickname + uuid persisted per device. */
const KEY = "ktv-identity-v1";
let memoryIdentityRaw: string | null = null;

export type Identity = { user_id: string; nickname: string; fingerprint?: string };

function makeFingerprint(): string {
  if (typeof window === "undefined") return "";
  const nav = window.navigator;
  const seed = [nav.userAgent, nav.language, String(window.screen?.width || 0), String(window.screen?.height || 0)].join("|");
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `fp_${h.toString(16)}`;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function getIdentity(): Identity | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage?.getItem?.(KEY) ?? memoryIdentityRaw;
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
  const next: Identity = { user_id: cur?.user_id || uuid(), nickname, fingerprint: cur?.fingerprint || makeFingerprint() };
  const raw = JSON.stringify(next);
  memoryIdentityRaw = raw;
  window.localStorage?.setItem?.(KEY, raw);
  return next;
}

export function clearIdentity(): void {
  memoryIdentityRaw = null;
  if (typeof window !== "undefined") window.localStorage?.removeItem?.(KEY);
}
