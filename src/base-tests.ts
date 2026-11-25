// Row 275 (C29, C32). The `base-tests` job: drive runs the base commit's suite in the scratch when no
// shipped summary holds the base's code. Its key names the base commit and the suite (`suiteKey`).

export const BASE_TESTS = 'base-tests'

export function baseTestsKey(commit: string, suite: string): string {
  return `${commit}.${suite}`
}

export function parseBaseTestsKey(key: string): { commit: string; suite: string } | undefined {
  const m = /^([0-9a-f]{40}|[0-9a-f]{64})\.([0-9a-f]{12})$/.exec(key)
  return m ? { commit: m[1]!, suite: m[2]! } : undefined
}
