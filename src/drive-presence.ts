// Row 180. What a process knows about the drive it runs under. Drive marks every child
// session with WITNESS_DRIVE=<target>: the marker is the recursion guard (a marked session's
// `witness drive` refuses) and the child's scope (its `next` answers for that target alone).
export const DRIVE_ENV = 'WITNESS_DRIVE'
export const TARGETLESS = '-'     // the marker's value for work with no target

// unset → undefined · '-' → { target: undefined } · else → { target: <value> }
export function driveChild(env: Record<string, string | undefined>): { target: string | undefined } | undefined {
  const marker = env[DRIVE_ENV]
  if (marker === undefined || marker === '') return undefined
  return { target: marker === TARGETLESS ? undefined : marker }
}
