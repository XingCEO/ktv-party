export function shallowEqualArrayById<T extends { id: number | string }>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
  }
  return true;
}

export function isEqualQueue(
  a: ReadonlyArray<{ id: number; status: string; position: number; vocal_mode: string }>,
  b: ReadonlyArray<{ id: number; status: string; position: number; vocal_mode: string }>
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    if (
      ai.id !== bi.id ||
      ai.status !== bi.status ||
      ai.position !== bi.position ||
      ai.vocal_mode !== bi.vocal_mode
    ) {
      return false;
    }
  }
  return true;
}
