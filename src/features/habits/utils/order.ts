export function haveSameIdSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  if (setA.size !== b.length || new Set(b).size !== b.length) return false;
  for (const id of b) {
    if (!setA.has(id)) return false;
  }
  return true;
}

export function reconcileOrderedIds(
  previousOrder: number[],
  canonicalIds: number[]
): number[] {
  if (canonicalIds.length === 0) return [];
  if (previousOrder.length === 0) return canonicalIds;

  const canonicalSet = new Set(canonicalIds);
  const next: number[] = [];
  const seen = new Set<number>();

  for (const id of previousOrder) {
    if (!canonicalSet.has(id) || seen.has(id)) continue;
    next.push(id);
    seen.add(id);
  }

  for (const id of canonicalIds) {
    if (seen.has(id)) continue;
    next.push(id);
  }

  return next;
}

export function mergeReorderedSubsetIntoOrder(
  fullOrderIds: number[],
  reorderedSubsetIds: number[]
): number[] | null {
  const subsetSet = new Set(reorderedSubsetIds);
  let cursor = 0;
  const merged = fullOrderIds.map((id) => {
    if (!subsetSet.has(id)) {
      return id;
    }
    const nextId = reorderedSubsetIds[cursor];
    cursor += 1;
    return nextId;
  });

  if (cursor !== reorderedSubsetIds.length) {
    return null;
  }

  return merged;
}

export function isSameOrder(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
