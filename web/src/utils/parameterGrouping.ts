export interface ParameterGroup<T> {
  title: string;
  params: T[];
}

export function groupParameters<T>(
  params: T[],
  classify: (p: T) => 'tx' | 'rx' | 'common'
): ParameterGroup<T>[] {
  const common: T[] = [];
  const tx: T[] = [];
  const rx: T[] = [];

  for (const p of params) {
    const cat = classify(p);
    if (cat === 'tx') tx.push(p);
    else if (cat === 'rx') rx.push(p);
    else common.push(p);
  }

  const groups: ParameterGroup<T>[] = [];
  if (common.length > 0) groups.push({ title: 'Common', params: common });
  if (tx.length > 0) groups.push({ title: 'Tx', params: tx });
  if (rx.length > 0) groups.push({ title: 'Rx', params: rx });
  return groups;
}
