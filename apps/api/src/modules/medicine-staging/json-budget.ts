/** Conservative JSON expansion estimate, without materializing the complete document.
 * Our schemas have fixed shallow depth; 64 bytes per node covers pretty-print spacing.
 * Shared references are counted on every occurrence, as they are when serialized.
 */
export function jsonBudget(value: unknown, limit: number): number {
  let bytes = 0;
  const visit = (v: unknown) => {
    if (bytes > limit) return;
    bytes += 64;
    if (v !== null && typeof v === 'object') {
      if (Array.isArray(v)) {
        for (const item of v) {
          visit(item);
          if (bytes > limit) break;
        }
      } else {
        for (const [key, item] of Object.entries(v)) {
          bytes += Buffer.byteLength(JSON.stringify(key));
          visit(item);
          if (bytes > limit) break;
        }
      }
    } else bytes += Buffer.byteLength(JSON.stringify(v) ?? 'null');
  };
  visit(value);
  return bytes;
}
export function assertJsonBudget(value: unknown, limit: number) {
  const size = jsonBudget(value, limit);
  if (size > limit) throw new Error('Expanded staging JSON budget exceeded.');
  return size;
}
