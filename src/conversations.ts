import { join } from 'node:path'

import { inTurn, readForChange, readIfThere, writeJson } from './fsutil.ts'

// What Hopper knows about the conversations it started that Claude Code doesn't report: the model
// and effort they started with, whether in a worktree, and the routine a run belongs to. Keyed by
// the short session id.
export type ConversationMeta = {
  model?: string
  effort?: string
  worktree?: boolean
  project: string
  routine?: string
  startedAt: number
  // The draft it started from, which is how other drafts name it in `after:`.
  draft?: string
  // Started with nobody watching (a routine, or dispatch): it writes a result file.
  unattended?: boolean
  result?: string
  depth?: number
  // The queue it started from, which its follow-ups inherit.
  queue?: 'now' | 'night'
}

const file = (home: string) => join(home, 'state', 'conversations.json')

function parseConversations(text: string | null): Record<string, ConversationMeta> {
  const raw = JSON.parse(text ?? '{}') as unknown
  return raw && typeof raw === 'object' ? (raw as Record<string, ConversationMeta>) : {}
}

// For showing: a file that can't be read knows nothing.
export async function loadConversations(home: string): Promise<Record<string, ConversationMeta>> {
  try {
    return parseConversations(await readIfThere(file(home)))
  } catch {
    return {}
  }
}

export const recordConversation = (home: string, id: string, meta: ConversationMeta) =>
  inTurn(file(home), async () => {
    const all = await readForChange(file(home), parseConversations)
    all[id] = meta
    await writeJson(file(home), all)
  })

// The models and efforts a draft cycles through; undefined means Claude's own default.
export const MODELS = [undefined, 'haiku', 'sonnet', 'opus', 'opus[1m]', 'fable'] as const
export const EFFORTS = [undefined, 'low', 'medium', 'high'] as const
export const WORKTREE_CHOICES = [undefined, 'yes', 'no'] as const

export function nextOf<T>(list: readonly (T | undefined)[], current: T | undefined): T | undefined {
  const i = list.indexOf(current)
  return list[(i + 1) % list.length]
}
