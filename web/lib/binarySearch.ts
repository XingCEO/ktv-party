/** Find largest index i where pred(arr[i]) is true, using binary search.
    Returns -1 if no element satisfies. Optional `hint` is the last result —
    if hint is still valid (or only off by 1-2 forward), uses linear scan
    from there for typical realtime media use case (lyric tick). */
export function lastTrueIndex<T>(
  arr: ReadonlyArray<T>,
  pred: (item: T) => boolean,
  hint?: number,
): number {
  if (arr.length === 0) return -1;

  if (hint !== undefined && hint >= 0 && hint < arr.length) {
    if (pred(arr[hint])) {
      let i = hint;
      while (i + 1 < arr.length && pred(arr[i + 1])) {
        i++;
      }
      return i;
    }
  }

  let low = 0;
  let high = arr.length - 1;
  let result = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (pred(arr[mid])) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}
