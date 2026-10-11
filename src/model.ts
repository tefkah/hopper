import {
  fetchAuth,
  fetchSessions,
  readUsage,
  type Auth,
  type Session,
  type Usage,
} from './claude.ts'
import { chosen, defaultsFor, type Account, type Config } from './config.ts'
import { loadConversations } from './conversations.ts'
import { inWindow, readiness } from './dispatch.ts'
import { loadDone } from './done.ts'
import { listDrafts, type Draft } from './drafts.ts'
import { loadHeld } from './held.ts'
import { loadProjects, readOpenCount, type Project } from './home.ts'
import { isWithin } from './paths.ts'
import {
  listReports,
  listRoutines,
  lastRan,
  listRuns,
  nextRun,
  readResult,
  type Report,
  type Result,
  type Routine,
  type Run,
} from './routines/index.ts'
import { pickAccount } from './routing.ts'
import { isRead, loadRead } from './seen.ts'
import { findTranscript, readTranscript } from './transcript.ts'

// Sessions whose cwd is under no project are grouped here, so outside work still shows.
// The leading ~ sorts it after every real key in the tree.
export const OTHER = '~elsewhere'

// 'filed' is a routine's run once it has finished: it lives in its routine's reports, not in
// the list or Done.
export type Where = 'queue' | 'needs' | 'done' | 'live' | 'routine' | 'filed'

// The queue is what's running. Everything else waits on me in Needs you (Claude's "done" means
// it answered and is waiting) until I mark it done. Interactive terminals belong to neither.
const WAITING = new Set(['blocked', 'done', 'failed', 'stopped'])

export function classify(s: Session, done: Set<string> = new Set()): Where {
  if (s.kind === 'interactive') return 'live'
  if (s.kind === 'routine') return 'routine'
  if (done.has(s.sessionId)) return 'done'
  if (s.kind === 'draft') return 'needs'
  if (WAITING.has(s.state)) return 'needs'
  return 'queue'
}

// What counts as waiting on me: in the title, the project's numbers, the chime and `n`. A
// conversation on hold waits too, but I already know about it.
export const waitsOnMe = (i: Item) => i.where === 'needs' && !i.held

export function projectForCwd(projects: Project[], cwd: string): Project | undefined {
  let best: Project | undefined
  for (const p of projects) {
    if (isWithin(cwd, p.path) && (!best || p.path.length > best.path.length)) best = p
  }
  return best
}

export type Item = Session & {
  where: Where
  key: string
  // When it last changed hands, which lists sort by. A working conversation: when I last wrote
  // to it; one that has stopped: its newest message. Both read from its transcript, or its start
  // when that's later or there's no transcript. For a draft, its last edit, and for a routine,
  // its last run, as startedAt.
  activeAt: number
  // Recorded by Hopper when it started the conversation; for a routine, what its runs start with.
  model?: string
  effort?: string
  // 'yes' to work in a git worktree, 'no' to edit its folder in place: what a conversation started
  // with, or what a draft picked, like model and effort.
  worktree?: string
  // The full id of the model its newest reply came from, read from its transcript, and when.
  ranOn?: string
  repliedAt?: number
  // Waiting on me, but on hold (held.ts): I know about it and can't act yet.
  held?: boolean
  routine?: string
  // For a routine's run or an unattended conversation: what its result file says.
  result?: Result | null
  resultPath?: string
  // Started with nobody watching.
  unattended?: boolean
  // For a routine: how many of its reports I haven't read (seen.ts); unset when none.
  unread?: number
  // For a routine: when it next runs; unset when paused or run-now-only. Its startedAt is when
  // it last ran.
  nextAt?: number
  // The draft a conversation started from; for a draft, its own id.
  draft?: string
  // A draft's overnight fields (drafts.ts).
  queue?: Draft['queue']
  after?: string[]
  done?: string
  proposed?: string
  // For a queued draft: why it hasn't started, or undefined when it's ready.
  waiting?: string
}

export type AccountState = {
  account: Account
  auth: Auth | null
  authError: string | null
  usage: Usage | null
  sessionError: string | null
  // The last list claude gave, and when. A failed poll keeps it rather than showing nothing, so
  // a slow answer doesn't empty the queue; sessionsAt says how old it has grown.
  sessions: Session[]
  sessionsAt: number | null
  counts: { queue: number; needs: number; done: number; live: number }
}

export type Snapshot = {
  at: number
  drafts: Draft[]
  routines: Routine[]
  runs: Run[]
  // Each routine's reports, by routine name, newest first.
  reports: Record<string, Report[]>
  projects: Project[]
  projectsError: string | null
  openCounts: Map<string, number | null>
  accounts: AccountState[]
  items: Item[]
}

export function toItems(
  sessions: Session[],
  projects: Project[],
  done: Set<string> = new Set(),
): Item[] {
  return sessions
    .map((s) => ({
      ...s,
      where: classify(s, done),
      key: projectForCwd(projects, s.cwd)?.key ?? OTHER,
      activeAt: s.startedAt,
    }))
    .sort(byActivity)
}

// The snapshot with one conversation marked done or not, at once, for the list to move before
// the next load says the same. Brought back, it goes where it would without the mark.
export function withDone(snap: Snapshot, sessionId: string, done: boolean): Snapshot {
  const items = snap.items.map((i) =>
    i.sessionId !== sessionId ? i : { ...i, where: done ? ('done' as const) : classify(i) },
  )
  const accounts = snap.accounts.map((a) => {
    const mine = items.filter((i) => i.account === a.account.name)
    const n = (w: Where) => mine.filter((i) => i.where === w && !i.held).length
    return {
      ...a,
      counts: { queue: n('queue'), needs: n('needs'), done: n('done'), live: n('live') },
    }
  })
  return { ...snap, items, accounts }
}

export const byActivity = (a: Item, b: Item) => b.activeAt - a.activeAt

// Claude is in the middle of a turn: a background conversation running, or a busy terminal one.
export const isWorking = (i: Item) => i.where === 'queue' || i.state === 'busy'

// A draft shows alongside conversations, as one that hasn't started. Its session id is
// namespaced so it can be marked done like any other.
export const draftSessionId = (id: string) => `draft:${id}`
export const routineSessionId = (name: string) => `routine:${name}`

export function draftSession(d: Draft, projects: Project[], account: string): Session {
  const firstLine = d.text.split('\n').find((l) => l.trim()) ?? '(empty draft)'
  return {
    account,
    id: null,
    sessionId: draftSessionId(d.id),
    kind: 'draft',
    cwd: projects.find((p) => p.key === d.project)?.path ?? '',
    name: firstLine.trim(),
    startedAt: d.updated,
    state: 'draft',
  }
}

export function inScope(key: string, scope: string | null): boolean {
  if (!scope) return true
  return key === scope || key.startsWith(scope + '/')
}

// Auth changes rarely and costs a process per login, so callers pass the last result and
// only re-fetch it when asked.
export async function gather(
  config: Config,
  previous: Snapshot | null,
  withAuth: boolean,
): Promise<Snapshot> {
  let projects: Project[] = []
  let projectsError: string | null = null
  try {
    projects = await loadProjects(config.home)
  } catch (e) {
    projectsError =
      (e as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'no projects.toml; run hopper init'
        : (e as Error).message
  }
  const openCounts = new Map<string, number | null>()
  await Promise.all(projects.map(async (p) => openCounts.set(p.key, await readOpenCount(p))))

  const perAccount = await Promise.all(
    config.accounts.map(async (account) => {
      const prev = previous?.accounts.find((a) => a.account.name === account.name)
      let auth = prev?.auth ?? null
      let authError = prev?.authError ?? null
      if (withAuth || !prev) {
        try {
          auth = await fetchAuth(account)
          authError = null
        } catch (e) {
          authError = (e as Error).message
        }
      }
      let sessions = prev?.sessions ?? []
      let sessionsAt = prev?.sessionsAt ?? null
      let sessionError: string | null = null
      try {
        sessions = await fetchSessions(account)
        sessionsAt = Date.now()
      } catch (e) {
        sessionError = (e as Error).message
      }
      const usage = await readUsage(account)
      return { account, auth, authError, usage, sessionError, sessions, sessionsAt }
    }),
  )

  const drafts = await listDrafts(config.home)
  const routines = await listRoutines(config.home)
  const runs = await listRuns(config.home)
  const states = perAccount.map((a) => ({
    ...a,
    counts: { queue: 0, needs: 0, done: 0, live: 0 },
  }))
  const draftSessions = drafts.map((d) =>
    draftSession(d, projects, pickAccount(config, d.project, states).account?.name ?? '–'),
  )
  const now = new Date()
  const routineSessions: Session[] = routines.map((r) => ({
    account: pickAccount(config, r.project, states).account?.name ?? '–',
    id: null,
    sessionId: routineSessionId(r.name),
    kind: 'routine',
    cwd: projects.find((p) => p.key === r.project)?.path ?? '',
    name: r.name,
    // When it last started or passed; 0 if it never has.
    startedAt: lastRan(runs, r.name)?.at ?? 0,
    state: r.enabled ? (r.schedule ? 'scheduled' : 'manual') : 'paused',
  }))
  const items = toItems(
    [...perAccount.flatMap((a) => a.sessions), ...draftSessions, ...routineSessions],
    projects,
    await loadDone(config.home),
  )
  const routineOf = new Map(routines.map((r) => [routineSessionId(r.name), r]))
  const projectKeys = new Set(projects.map((p) => p.key))
  for (const it of items) {
    if (it.kind !== 'routine') continue
    const r = routineOf.get(it.sessionId)
    if (!r) continue
    it.key = r.project
    // What its runs start with, which the list shows like a conversation's.
    it.model = chosen(
      r,
      defaultsFor(
        config,
        projects.find((p) => p.key === r.project),
      ),
    ).model
    const next = r.enabled ? nextRun(r.schedule, now) : null
    if (next) it.nextAt = next.getTime()
  }
  const meta = await loadConversations(config.home)
  for (const it of items) {
    const m = it.id ? meta[it.id] : undefined
    if (m?.model) it.model = m.model
    if (m?.effort) it.effort = m.effort
    if (m?.worktree !== undefined) it.worktree = m.worktree ? 'yes' : 'no'
    if (m?.routine) it.routine = m.routine
    if (m?.draft) it.draft = m.draft
    if (m?.unattended) it.unattended = true
    if (m?.result) it.resultPath = m.result
    // Several projects can run from one folder (a meta repo), so the folder alone can't say
    // which a conversation is for; the project Hopper started it in can.
    if (m?.project && projectKeys.has(m.project)) it.key = m.project
  }
  await Promise.all(
    items.map(async (it) => {
      if (it.kind !== 'background' && it.kind !== 'interactive') return
      const account = config.accounts.find((a) => a.name === it.account)
      if (!account) return
      const path = await findTranscript(account.configDir, it.cwd, it.sessionId)
      const read = path ? await readTranscript(path) : null
      if (read?.reply) it.ranOn = read.reply.model
      if (read?.reply?.at) it.repliedAt = read.reply.at
      // While it works, when I last wrote to it: its newest message changes with every tool
      // call, and the list would shuffle under me. Once it stops, its newest message is when
      // Claude stopped, finished or asking.
      const at = isWorking(it) ? read?.promptedAt : read?.activeAt
      if (at) it.activeAt = Math.max(it.startedAt, at)
    }),
  )
  items.sort(byActivity)
  const reports: Record<string, Report[]> = Object.fromEntries(
    await Promise.all(
      routines.map(async (r) => [r.name, await listReports(config.home, r.name, runs)] as const),
    ),
  )
  // An unattended conversation that finished and says nothing needs me goes straight to Archived.
  // A routine's run shows while it works; once finished it is filed with its routine's reports.
  // Only a run blocked on a question stays in the list, because
  // the conversation is the one place to answer it.
  for (const it of items) {
    if (!it.id || (!it.routine && !it.resultPath)) continue
    const path = it.resultPath ?? runs.find((r) => r.id === it.id)?.result
    const listed = path && it.routine ? reports[it.routine]?.find((x) => x.path === path) : null
    it.result = listed ?? (path ? await readResult(path) : null)
    if (path && !it.resultPath) it.resultPath = path
    if (it.routine) {
      if (it.where === 'done' || (it.where === 'needs' && it.state !== 'blocked'))
        it.where = 'filed'
    } else if (it.where === 'needs' && it.state === 'done' && it.result?.needs === 'nothing')
      it.where = 'done'
  }
  // A hold lasts while the conversation waits and Claude hasn't answered since: replying to it
  // ends it, so what comes back is new.
  const held = await loadHeld(config.home)
  for (const it of items) {
    const at = held.get(it.sessionId)
    if (at === undefined || it.where !== 'needs' || it.kind === 'draft') continue
    if (!it.repliedAt || it.repliedAt <= at) it.held = true
  }
  const read = await loadRead(config.home)
  for (const [name, list] of Object.entries(reports))
    for (const rep of list) if (!isRead(read, name, rep)) rep.unread = true
  for (const it of items) {
    if (it.kind !== 'routine') continue
    const name = routineOf.get(it.sessionId)?.name
    const n = name ? (reports[name]?.filter((x) => x.unread).length ?? 0) : 0
    if (n) it.unread = n
  }
  const itemOf = new Map(items.map((i) => [i.sessionId, i]))
  for (const d of drafts) {
    const it = itemOf.get(draftSessionId(d.id))
    if (!it) continue
    it.draft = d.id
    if (d.model) it.model = d.model
    if (d.effort) it.effort = d.effort
    if (d.worktree) it.worktree = d.worktree
    if (d.queue) {
      it.queue = d.queue
      it.state = d.queue === 'night' ? 'tonight' : 'queued'
      const r = await readiness(d, { drafts, meta, items })
      if (!r.ready) it.waiting = r.reason
      else if (d.queue === 'night' && !inWindow(config.overnight.window, now))
        it.waiting = `starts in the night window (${config.overnight.window})`
    }
    if (d.after) it.after = d.after
    if (d.done) it.done = d.done
    if (d.proposed) it.proposed = d.proposed
  }
  // A draft's project comes from the draft, not from matching its folder.
  const draftOf = new Map(drafts.map((d) => [draftSessionId(d.id), d]))
  for (const it of items)
    if (it.kind === 'draft') it.key = draftOf.get(it.sessionId)?.project ?? it.key
  const accounts: AccountState[] = perAccount.map((a) => {
    const mine = items.filter((i) => i.account === a.account.name)
    const n = (w: Where) => mine.filter((i) => i.where === w && !i.held).length
    return {
      ...a,
      counts: { queue: n('queue'), needs: n('needs'), done: n('done'), live: n('live') },
    }
  })
  return {
    at: Date.now(),
    drafts,
    routines,
    runs,
    reports,
    projects,
    projectsError,
    openCounts,
    accounts,
    items,
  }
}
