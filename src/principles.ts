import { tryGit } from './gitio.js'
import type { CanonDoc } from './scan.js'

// Row 219. The template `witness init` writes, born approved. An older init wrote it draft.
export const PRINCIPLES_BODY = `# Principles

Repo-wide rules and trade-offs. Amend via \`witness write\`; chores may name
this doc as their plan's parent.
`

// Row 219. The principles an older init left: the template, still draft, its body untouched and
// its file clean — what `witness migrate` stamps approved. A changed body is content someone
// wrote, which only a gate approves. One predicate for migrate, `next` and `write`'s refusal.
export function templateDraft(root: string, doc: CanonDoc | undefined): doc is CanonDoc {
  if (doc === undefined || doc.meta.type !== 'principles' || String(doc.meta.status) !== 'draft') return false
  const norm = (t: string): string => t.replace(/\r\n?/g, '\n').trim()
  if (norm(doc.body) !== norm(PRINCIPLES_BODY)) return false
  return tryGit(root, 'status', '--porcelain', '--', doc.rel).out.trim() === ''
}
