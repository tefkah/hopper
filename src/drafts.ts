import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { WORKTREES } from './config.ts'
import { parseFrontmatter, serializeFrontmatter, timeField } from './frontmatter.ts'
import { readIfThere, writeAtomic } from './fsutil.ts'

// A conversation that hasn't started yet: somewhere to take your time with the first message.
// It saves as you type, waits in Needs you, and starts when you say so. Kept in the home folder.
export type Draft = {
  id: string
  project: string
  text: string
  created: number
  updated: number
  model?: string
  effort?: string
  // 'yes' to work in a git worktree, 'no' to edit the run folder in place. Queued, always a worktree.
  worktree?: string
  // Up next: start on its own when an account has room ('now'), or only in the night window.
  // Queued work runs unattended. See dispatch.ts.
  queue?: Queue
  // Drafts whose conversations must finish first.
  after?: string[]
  // What finished looks like, so an unattended run knows when to stop.
  done?: string
  // Written by an agent for me to approve: the routine or conversation that proposed it.
  proposed?: string
  // Links from the first draft of a chain of follow-ups; 0 for one I wrote.
  depth?: number
}

export const QUEUES = ['now', 'night'] as const
export type Queue = (typeof QUEUES)[number]

const INBOX = 'meta/inbox'

const dir = (home: string) => join(home, 'drafts')
const file = (home: string, id: string) => join(dir(home), `${id}.md`)

export const newDraftId = (now = Date.now()) =>
  `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`

export const serializeDraft = (d: Draft): string =>
  serializeFrontmatter(
    {
      project: d.project,
      created: new Date(d.created).toISOString(),
      updated: new Date(d.updated).toISOString(),
      model: d.model,
      effort: d.effort,
      worktree: d.worktree,
      queue: d.queue,
      after: d.after?.length ? d.after.join(', ') : undefined,
      done: d.done,
      proposed: d.proposed,
      depth: d.depth ? String(d.depth) : undefined,
    },
    d.text,
  )

// A file with no front matter is a note dropped in from elsewhere (the phone, through a synced folder):
// it files to meta/inbox and takes its times from the file. It gets front matter on first save.
export function parseDraft(id: string, text: string, fileTime = 0): Draft | null {
  const parsed = parseFrontmatter(text.replace(/\r\n/g, '\n'))
  if (!parsed) {
    if (!text.trim()) return null
    return { id, project: INBOX, text, created: fileTime, updated: fileTime }
  }
  const f = parsed.fields
  const draft: Draft = {
    id,
    project: f['project'] || INBOX,
    text: parsed.body,
    created: timeField(f['created']) || fileTime,
    updated: timeField(f['updated']) || fileTime,
  }
  if (f['model']) draft.model = f['model']
  if (f['effort']) draft.effort = f['effort']
  if (WORKTREES.includes(f['worktree'] as never)) draft.worktree = f['worktree']
  if (QUEUES.includes(f['queue'] as Queue)) draft.queue = f['queue'] as Queue
  const after = (f['after'] ?? '').split(/[,\s]+/).filter(Boolean)
  if (after.length) draft.after = after
  if (f['done']) draft.done = f['done']
  if (f['proposed']) draft.proposed = f['proposed']
  const depth = Number(f['depth'])
  if (Number.isInteger(depth) && depth > 0) draft.depth = depth
  return draft
}

export async function listDrafts(home: string): Promise<Draft[]> {
  const names = await readdir(dir(home)).catch(() => [] as string[])
  const drafts = await Promise.all(
    names
      .filter((n) => n.endsWith('.md'))
      .map(async (n) => {
        const path = join(dir(home), n)
        const text = await readIfThere(path)
        if (text === null) return null
        const mtime = await stat(path).then(
          (s) => s.mtimeMs,
          () => 0,
        )
        return parseDraft(n.slice(0, -3), text, mtime)
      }),
  )
  return drafts.filter((d): d is Draft => !!d).sort((a, b) => b.updated - a.updated)
}

export const saveDraft = (home: string, d: Draft) =>
  writeAtomic(file(home, d.id), serializeDraft(d))

export async function deleteDraft(home: string, id: string): Promise<void> {
  await rm(file(home, id), { force: true })
}
