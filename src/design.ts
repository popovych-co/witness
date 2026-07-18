import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonPaths } from './config.js'
import { latestRecap, readStream, type Entry } from './journal.js'
import { v, type Violation } from './refusal.js'
import { effortOf } from './reviewed.js'
import type { CanonDoc } from './scan.js'
import { canonicalSha } from './sha.js'

export function elementIds(html: string): string[] {
  const ids: string[] = []
  const re = /\bid\s*=\s*["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) ids.push(m[1]!.trim())
  return ids
}

// A design artifact is a portable, self-contained mockup: it must render with no
// network, and it must expose id-attributed sections so the design-critic can anchor
// findings to concrete parts of the screen (the anchor grammar's targets).
const EXTERNAL_REFS: Array<[RegExp, string]> = [
  [/<script[^>]*\bsrc\s*=/i, 'external <script src> — inline the script'],
  [/<link[^>]*\bhref\s*=\s*["'](?:https?:)?\/\//i, 'external <link href> — inline the stylesheet'],
  [/<img[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\//i, 'external <img src> — embed as a data: URI'],
  [/<[^>]*\bsrcset\s*=\s*["'][^"']*(?:https?:)?\/\//i, 'external srcset — embed as data: URIs'],
  [/url\(\s*["']?(?:https?:)?\/\//i, 'external url() in CSS — embed the asset'],
]

export function validateDesignArtifact(html: string): Violation[] {
  const out: Violation[] = []
  for (const [re, why] of EXTERNAL_REFS) {
    if (re.test(html)) { out.push(v('artifact', 'external-ref', why, 'a self-contained artifact — no external resource refs')); break }
  }
  const ids = elementIds(html)
  const unique = new Set(ids)
  if (unique.size !== ids.length) {
    out.push(v('artifact', 'duplicate-id', `${ids.length} ids, ${unique.size} unique`, 'unique id attributes — anchors must be unambiguous'))
  }
  if (unique.size < 2) {
    out.push(v('artifact', 'template', `${unique.size} id-attributed element(s)`, '>=2 id-attributed sections — the design-critic anchors to element ids'))
  }
  if (!/<!doctype html/i.test(html) && !/<html[\s>]/i.test(html) && !/<body[\s>]/i.test(html)) {
    out.push(v('artifact', 'not-html', html.slice(0, 40), 'an HTML document (<!doctype html> / <html> / <body>)'))
  }
  return out
}

export function htmlSha(html: string): string {
  return createHash('sha256').update(html.replace(/\s+$/, '') + '\n').digest('hex')
}

export function designPairSha(html: string, spec: CanonDoc): string {
  return createHash('sha256')
    .update(`design:${htmlSha(html)}\n`)
    .update(`spec:${canonicalSha(spec.meta, spec.body)}`)
    .digest('hex')
}

export function designRel(paths: CanonPaths, specId: string): string {
  return `${paths.designs}/${specId}.html`
}

export function designStamp(spec: CanonDoc): { sha: string; spec: string } | undefined {
  const s = spec.meta.design as { sha?: unknown; spec?: unknown } | undefined
  if (!s || typeof s.sha !== 'string' || typeof s.spec !== 'string') return undefined
  return { sha: s.sha, spec: s.spec }
}

// The single home for "this ui spec owes a design": a ui-flagged spec in a
// feature-class effort whose design stamp is missing or stale (designed against
// older content). fix/chore efforts never arm it (Q2). next/dashboard/check/gate
// all consult this — never re-derive the rule.
export function designPending(root: string, spec: CanonDoc): boolean {
  if (spec.meta.type !== 'spec' || spec.meta.ui !== true) return false
  const effort = effortOf(root, String(spec.meta.id))
  if (!effort) return false
  if (latestRecap(root, effort)?.class !== 'feature') return false
  const stamp = designStamp(spec)
  return !stamp || stamp.spec !== canonicalSha(spec.meta, spec.body)
}

// Is an artifact authored for the CURRENT spec content already on disk (a design-write
// entry whose `spec` sha equals the current canonical sha)? Distinguishes "authored,
// awaiting gate" from "amended since the last artifact" — routing keys on this instead
// of file existence, so an amendment (stale artifact) correctly re-enters the design skill.
export function designArtifactCurrent(root: string, spec: CanonDoc): boolean {
  const cur = canonicalSha(spec.meta, spec.body)
  return readStream(root, String(spec.meta.id)).some(
    (e) => e.t === 'design-write' && (e as { spec?: string }).spec === cur,
  )
}

// Pure half: has a human been shown THESE exact bytes? Sha-keyed, because a re-authored
// artifact is a different thing to look at — the same discipline that makes a re-captured
// screenshot invalidate its predecessor's witnessed sha (D71).
export function designShown(entries: Entry[], sha: string): boolean {
  return entries.some((e) => e.t === 'design-shown' && (e as { sha?: string }).sha === sha)
}

// The single home for "this artifact is registered but nobody has been shown it".
// Returns the unwitnessed sha, or undefined when there is nothing to see (no artifact)
// or a design-shown entry already covers the current bytes. gate/decide/next all consult
// this — never re-derive the rule.
export function designUnseen(root: string, paths: CanonPaths, specId: string): string | undefined {
  const abs = join(root, designRel(paths, specId))
  if (!existsSync(abs)) return undefined
  const sha = htmlSha(readFileSync(abs, 'utf8'))
  return designShown(readStream(root, specId), sha) ? undefined : sha
}
