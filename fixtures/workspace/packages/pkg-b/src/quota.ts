export function remaining(used: number, total: number): number {
  return Math.max(0, total - used)
}
