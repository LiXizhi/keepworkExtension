export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const object = value as Record<string, unknown>;
  const entries = Object.keys(object)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalize(object[key])}`);
  return `{${entries.join(',')}}`;
}
