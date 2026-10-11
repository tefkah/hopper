import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { defaultsFor, type Config } from './config.ts'
import { EFFORTS, loadConversations, MODELS } from './conversations.ts'
import { dispatch, lastDispatch, readiness, recordDispatch } from './dispatch.ts'
import { listDrafts, newDraftId, QUEUES, saveDraft, type Draft, type Queue } from './drafts.ts'
import { loadProjects } from './home.ts'
import { gather, type Item, type Snapshot } from './model.ts'
import {
  checkSchedule,
  loadRoutine,
  nextRun,
  parseRoutine,
  ROUTINE_NAME,
  routinesDir,
  saveRoutine,
  type Routine,
} from './routines/index.ts'
import { groupOf } from './tui/state.ts'

// The commands agents use, so they never hand-edit Hopper's state: list, draft new, routine
// check and install, dispatch. Each returns what it would print; cli.tsx prints it.

export class UsageError extends Error {}

// `--flag value` and `--flag=value` pairs, plus positionals. Flags named in `bools` take no value.
export function parseArgs(
  argv: string[],
  bools: string[] = [],
): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--') || a === '--') {
      rest.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2)
    if (eq > 0) flags[name] = a.slice(eq + 1)
    else if (bools.includes(name)) flags[name] = 'true'
    else {
      const v = argv[i + 1]
      if (v === undefined) throw new UsageError(`--${name} needs a value`)
      flags[name] = v
      i++
    }
  }
  return { flags, rest }
}

// ---------- hopper list ----------

// Everything Hopper sees, for agents: the shape is documented in docs/agents.md.
export async function listJson(config: Config, snap?: Snapshot) {
  const s = snap ?? (await gather(config, null, false))
  const meta = await loadConversations(config.home)
  const lastByProject = new Map<string, number>()
  for (const m of Object.values(meta))
    lastByProject.set(m.project, Math.max(lastByProject.get(m.project) ?? 0, m.startedAt))
  const iso = (t: number | undefined) => (t ? new Date(t).toISOString() : null)
  const group = (i: Item) => (i.where === 'done' || i.where === 'filed' ? i.where : groupOf(i))
  const drafts = await Promise.all(
    s.drafts.map(async (d) => {
      const r = await readiness(d, { drafts: s.drafts, meta, items: s.items })
      return {
        id: d.id,
        project: d.project,
        text: d.text,
        created: iso(d.created),
        updated: iso(d.updated),
        model: d.model ?? null,
        effort: d.effort ?? null,
        worktree: d.worktree ?? null,
        queue: d.queue ?? null,
        after: d.after ?? [],
        done: d.done ?? null,
        proposed: d.proposed ?? null,
        depth: d.depth ?? 0,
        ready: r.ready,
        waiting: r.ready ? null : r.reason,
      }
    }),
  )
  const conversations = s.items
    .filter((i) => i.kind === 'background' || i.kind === 'interactive')
    .map((i) => ({
      id: i.id,
      sessionId: i.sessionId,
      name: i.name,
      project: i.key,
      group: i.kind === 'interactive' ? 'terminal' : group(i),
      state: i.state,
      account: i.account,
      model: i.model ?? null,
      effort: i.effort ?? null,
      worktree: i.worktree ?? null,
      ranOn: i.ranOn ?? null,
      routine: i.routine ?? null,
      draft: i.draft ?? null,
      unattended: !!i.unattended,
      cwd: i.cwd,
      startedAt: iso(i.startedAt),
      activeAt: iso(i.activeAt),
      result: i.resultPath
        ? { path: i.resultPath, needs: i.result?.needs ?? null, summary: i.result?.summary ?? null }
        : null,
    }))
  const now = new Date()
  return {
    at: iso(s.at),
    home: config.home,
    overnight: config.overnight,
    // What a draft or routine that picks no model or effort runs with, here and per project.
    defaults: defaultsFor(config),
    projects: s.projects.map((p) => ({
      key: p.key,
      path: p.path,
      runIn: p.runIn,
      openFile: p.openFile || null,
      open: s.openCounts.get(p.key) ?? null,
      metaRepo: p.meta?.repo ?? null,
      defaults: defaultsFor(config, p),
      lastConversation: iso(lastByProject.get(p.key)),
    })),
    drafts,
    conversations,
    routines: s.routines.map((r) => ({
      name: r.name,
      project: r.project,
      schedule: r.schedule,
      model: r.model ?? null,
      effort: r.effort ?? null,
      enabled: r.enabled,
      check: r.check ?? null,
      next: r.enabled ? iso(nextRun(r.schedule, now)?.getTime()) : null,
    })),
    runs: s.runs.slice(0, 30).map((r) => ({ ...r, at: iso(r.at) })),
    dispatch: await lastDispatch(config.home),
  }
}

// The same, for a person: one line per thing, grouped.
export async function listText(config: Config): Promise<string> {
  const j = await listJson(config)
  const out: string[] = []
  const line = (d: { id: string; project: string; text: string }) =>
    `  ${d.id.padEnd(14)} ${d.project.padEnd(24)} ${(d.text.split('\n')[0] ?? '').slice(0, 60)}`
  const drafts = j.drafts
  const section = (title: string, rows: string[]) => {
    if (rows.length) out.push(title, ...rows, '')
  }
  section(
    'up next',
    drafts
      .filter((d) => d.queue)
      .map((d) => `${line(d)}  [${d.queue}${d.waiting ? ': ' + d.waiting : ', ready'}]`),
  )
  section(
    'proposed',
    drafts.filter((d) => d.proposed && !d.queue).map((d) => `${line(d)}  (${d.proposed})`),
  )
  section('drafts', drafts.filter((d) => !d.queue && !d.proposed).map(line))
  for (const g of ['waiting', 'running', 'done']) {
    section(
      g,
      j.conversations
        .filter((c) => c.group === g)
        .slice(0, g === 'done' ? 10 : 50)
        .map((c) => `  ${(c.id ?? '').padEnd(14)} ${c.project.padEnd(24)} ${c.name}`),
    )
  }
  return out.join('\n').trimEnd() || 'Nothing in Hopper.'
}

// ---------- hopper draft new ----------

export async function draftNew(
  config: Config,
  argv: string[],
  stdin: () => Promise<string>,
): Promise<{ draft: Draft; note?: string }> {
  const { flags, rest } = parseArgs(argv)
  const known = ['project', 'model', 'effort', 'queue', 'after', 'done', 'proposed']
  for (const f of Object.keys(flags)) if (!known.includes(f)) throw new UsageError(`No --${f}.`)
  let text = rest.join(' ')
  if (text === '-') text = await stdin()
  if (!text.trim()) throw new UsageError('Give the first message, or - to read it from stdin.')
  if (flags['model'] && !MODELS.includes(flags['model'] as never))
    throw new UsageError(`--model is one of ${MODELS.filter(Boolean).join(', ')}.`)
  if (flags['effort'] && !EFFORTS.includes(flags['effort'] as never))
    throw new UsageError(`--effort is one of ${EFFORTS.filter(Boolean).join(', ')}.`)
  if (flags['queue'] && !QUEUES.includes(flags['queue'] as Queue))
    throw new UsageError(`--queue is now or night.`)

  // What it follows: drafts not started yet, or conversations Hopper started from one.
  const after = (flags['after'] ?? '').split(/[,\s]+/).filter(Boolean)
  const drafts = await listDrafts(config.home)
  const meta = await loadConversations(config.home)
  const parents = after.map((id) => {
    const d = drafts.find((x) => x.id === id)
    if (d) return { project: d.project, depth: d.depth ?? 0, queue: d.queue }
    const m = meta[id] ?? Object.values(meta).find((x) => x.draft === id)
    if (!m) throw new UsageError(`--after ${id}: no draft or conversation by that id.`)
    return { project: m.project, depth: m.depth ?? 0, queue: m.queue }
  })

  const project = flags['project'] ?? parents[0]?.project
  if (!project) throw new UsageError('Give --project <key>.')
  const projects = await loadProjects(config.home)
  if (!projects.some((p) => p.key === project))
    throw new UsageError(`No project ${project}. hopper list shows them.`)

  const depth = parents.length ? Math.max(...parents.map((p) => p.depth)) + 1 : 0
  // A follow-up of a queued conversation queues the same way, while the chain is short enough.
  const inherited = parents.find((p) => p.queue)?.queue
  let queue = (flags['queue'] as Queue | undefined) ?? (after.length ? inherited : undefined)
  let proposed = flags['proposed']
  let note: string | undefined
  if (proposed) queue = undefined
  else if (queue && depth > config.overnight.chainDepth) {
    queue = undefined
    proposed = `chain after ${after.join(', ')}`
    note = `Chain is ${depth} deep, past chain_depth ${config.overnight.chainDepth}: proposed instead of queued.`
  }

  const now = Date.now()
  const draft: Draft = {
    id: newDraftId(now),
    project,
    text: text.replace(/\s*$/, '\n'),
    created: now,
    updated: now,
    ...(flags['model'] ? { model: flags['model'] } : {}),
    ...(flags['effort'] ? { effort: flags['effort'] } : {}),
    ...(queue ? { queue } : {}),
    ...(after.length ? { after } : {}),
    ...(flags['done'] ? { done: flags['done'] } : {}),
    ...(proposed ? { proposed } : {}),
    ...(depth ? { depth } : {}),
  }
  await saveDraft(config.home, draft)
  return note ? { draft, note } : { draft }
}

// ---------- hopper routine check / templates / install ----------

export type RoutineCheck = {
  name: string
  ok: boolean
  problems: string[]
  next: string | null
}

export async function routineCheck(config: Config, name: string): Promise<RoutineCheck> {
  const problems: string[] = []
  const out = (next: string | null = null): RoutineCheck => ({
    name,
    ok: !problems.length,
    problems,
    next,
  })
  if (!ROUTINE_NAME.test(name)) problems.push('names are lowercase letters, digits and hyphens')
  const text = await readFile(join(routinesDir(config.home), `${name}.md`), 'utf8').catch(
    () => null,
  )
  if (text === null) {
    problems.push(`no file routines/${name}.md`)
    return out()
  }
  const r = parseRoutine(name, text)
  if (!r) {
    problems.push('front matter missing, or no project: in it')
    return out()
  }
  const projects = await loadProjects(config.home).catch(() => [])
  if (!projects.some((p) => p.key === r.project)) problems.push(`no project ${r.project}`)
  const sched = checkSchedule(r.schedule)
  if (sched) problems.push(sched)
  if (r.model && !MODELS.includes(r.model as never)) problems.push(`unknown model ${r.model}`)
  if (r.effort && !EFFORTS.includes(r.effort as never)) problems.push(`unknown effort ${r.effort}`)
  if (!r.prompt.trim()) problems.push('the prompt is empty')
  const next = r.enabled ? nextRun(r.schedule, new Date()) : null
  return out(next ? next.toISOString() : null)
}

const templatesDir = new URL('../templates/routines/', import.meta.url)

export async function routineTemplates(): Promise<Routine[]> {
  const names = await readdir(templatesDir).catch(() => [] as string[])
  const all = await Promise.all(
    names
      .filter((n) => n.endsWith('.md'))
      .map(async (n) =>
        parseRoutine(n.slice(0, -3), await readFile(new URL(n, templatesDir), 'utf8')),
      ),
  )
  return all.filter((r): r is Routine => !!r)
}

// Adds a template to the home folder's routines, paused unless asked, never over one that's there.
export async function routineInstall(config: Config, argv: string[]): Promise<Routine> {
  const { flags, rest } = parseArgs(argv, ['enable'])
  const which = rest[0]
  const template = (await routineTemplates()).find((t) => t.name === which)
  if (!template)
    throw new UsageError(
      `Name a template: ${(await routineTemplates()).map((t) => t.name).join(', ')}`,
    )
  const name = flags['name'] ?? template.name
  if (await loadRoutine(config.home, name))
    throw new UsageError(`routines/${name}.md is already there; --name gives another name.`)
  const r: Routine = {
    ...template,
    name,
    enabled: flags['enable'] === 'true',
    ...(flags['project'] ? { project: flags['project'] } : {}),
    ...(flags['schedule'] !== undefined ? { schedule: flags['schedule'] } : {}),
    ...(flags['check'] ? { check: flags['check'] } : {}),
  }
  const projects = await loadProjects(config.home)
  if (!projects.some((p) => p.key === r.project))
    throw new UsageError(`No project ${r.project} here; --project <key> picks another.`)
  await saveRoutine(config.home, r)
  return r
}

// ---------- hopper dispatch ----------

export async function dispatchOnce(config: Config, snap?: Snapshot) {
  const s = snap ?? (await gather(config, null, true))
  const report = await dispatch({
    config,
    drafts: s.drafts,
    projects: s.projects,
    accounts: s.accounts,
    items: s.items,
  })
  await recordDispatch(config.home, report)
  return report
}
