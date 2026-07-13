export function rotateDue(elapsed: number, ttl: number): boolean {
  return elapsed >= ttl * 0.8
}

export function nextToken(prev: string): string {
  return `${prev}-r`
}
