import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { limitedNote, startBackground, unattendedPermissions, type Session } from '../claude.ts'
import { chosen, defaultsFor, type Config } from '../config.ts'
import { recordConversation } from '../conversations.ts'
import { readIfThere } from '../fsutil.ts'
import { extraDirs, type Project } from '../home.ts'
import type { AccountState } from '../model.ts'
import { hasRoom, routeFor } from '../routing.ts'
import { guidePath } from '../start.ts'
import { routinesDir, type Routine } from './files.ts'

export type Run = {
  routine: string
  at: number
  // passed: its check passed, so no conversation was needed.
  status: 'started' | 'skipped' | 'passed'
  reason?: string
  id?: string // the conversation's short id
  account?: string
  model?: string
  result?: string // where the run writes its result
  prompt: string // a short hash of the prompt it ran, to compare runs across tweaks
}

const runsFile = (home: string) => join(home, 'state', 'runs.jsonl')

export async function listRuns(home: string, routine?: string): Promise<Run[]> {
  const text = (await readIfThere(runsFile(home)).catch(() => null)) ?? ''
  if (!text) return []
  const runs: Run[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as Run
      if (!routine || r.routine === routine) runs.push(r)
    } catch {
      // a line cut short by a crash; skip it
    }
  }
  // Newest first; runs recorded in the same millisecond keep the order they were written.
  return runs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.at - a.r.at || b.i - a.i)
    .map((x) => x.r)
}

// A routine's newest run that did something: one that started a conversation or whose check
// passed. Skipped runs don't count. `runs` is newest first, as listRuns gives it.
export const lastRan = (runs: Run[], routine: string): Run | undefined =>
  runs.find((r) => r.routine === routine && r.status !== 'skipped')

async function recordRun(home: string, run: Run): Promise<void> {
  await mkdir(join(home, 'state'), { recursive: true })
  await appendFile(runsFile(home), JSON.stringify(run) + '\n')
}

export const promptHash = (prompt: string) =>
  createHash('sha256').update(prompt).digest('hex').slice(0, 8)

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export const resultPath = (home: string, name: string, at: Date) =>
  join(routinesDir(home), name, 'runs', `${stamp(at)}.md`)

export type Result = { needs: 'you' | 'nothing' | null; summary: string }

// A run's result file: a summary line, after "needs: you" or "needs: nothing" for a dispatched
// draft's (a chain goes on only past "nothing"). Routine reports don't carry the line any more;
// older ones do, and it's read past.
export async function readResult(path: string | undefined): Promise<Result | null> {
  if (!path) return null
  const text = await readIfThere(path).catch(() => null)
  if (text === null) return null
  const needs = /^\s*(?:---\s*\n)?\s*needs:\s*(you|nothing)\b/im.exec(text)?.[1] as
    | Result['needs']
    | undefined
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^\s*needs:.*$/im, '')
  const summary =
    body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#')) ?? ''
  return { needs: needs ?? null, summary }
}

// A report a routine left in its runs folder, with the run that wrote it when Hopper started
// that run (a report written by hand, or by a run no longer in the log, has none).
export type Report = Result & {
  path: string
  at: number
  id?: string | undefined // the conversation that wrote it
  account?: string | undefined
  unread?: boolean | undefined // set by gather (seen.ts)
}

// The stamp resultPath writes, back to a time.
const unstamp = (file: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/.exec(file)
  return m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!).getTime() : null
}

export const REPORTS_KEPT = 50

// A routine's reports, newest first, up to REPORTS_KEPT. The files are the list rather than the
// run log, so a report from a routine run some other way shows too.
export async function listReports(home: string, name: string, runs: Run[]): Promise<Report[]> {
  const dir = join(routinesDir(home), name, 'runs')
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.md'))
  const dated = await Promise.all(
    files.map(async (f) => {
      const path = join(dir, f)
      return { path, at: unstamp(f) ?? (await stat(path).catch(() => null))?.mtimeMs ?? 0 }
    }),
  )
  dated.sort((a, b) => b.at - a.at || b.path.localeCompare(a.path))
  return Promise.all(
    dated.slice(0, REPORTS_KEPT).map(async ({ path, at }) => {
      const run = runs.find((r) => r.result === path)
      const result = (await readResult(path)) ?? { needs: null, summary: '' }
      return { ...result, path, at, id: run?.id, account: run?.account }
    }),
  )
}

// What a run is told on top of the project prompt: where its result goes and what to put there.
export function routineInstructions(r: Routine, result: string, previous?: string): string {
  return [
    `This conversation is a scheduled run of the Hopper routine "${r.name}".`,
    'Nobody is watching it: never wait for an answer.',
    'Do what the prompt asks, then write a short result to',
    `${result} (create the folder if needed): a one-line summary first, then any detail.`,
    previous ? `The previous run's result is at ${previous}; read it for continuity.` : '',
    'Never send, publish or push anything yourself: leave drafts for the person to approve.',
  ]
    .filter(Boolean)
    .join(' ')
}

// A meta/ routine is Hopper's own and looks across projects (briefs, reviews, proposals): it
// may read every meta repo Hopper imports, and the code reached through their projects/ links.
export function lookAcross(r: Routine, projects: Project[]): string[] {
  if (!r.project.startsWith('meta/')) return []
  const repos = new Set<string>()
  for (const p of projects) if (p.meta) repos.add(p.meta.repo)
  return [...repos].sort()
}

export type RunOutcome =
  | { status: 'started'; id: string; account: string }
  | { status: 'skipped'; reason: string }
  | { status: 'passed' }

// A routine's check: a shell command in the project's run folder. Its output is kept to the end,
// which is where failures say what went wrong.
export function runCheck(
  command: string,
  cwd: string,
): Promise<{ ok: boolean; code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', command],
      { cwd, timeout: 30 * 60_000, maxBuffer: 32 << 20 },
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr ? '\n' + stderr : ''}`.trim().split('\n').slice(-150)
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        resolve({ ok: !err, code, output: output.join('\n') })
      },
    )
  })
}

// One run: pick an account with room (skip if none), start the conversation in the project's
// folder, and record it. Called by the app on schedule (autopilot.ts), by run-now, and by `hopper run`.
export async function runRoutine(opts: {
  config: Config
  routine: Routine
  projects: Project[]
  accounts: AccountState[]
  sessions: Pick<Session, 'id' | 'state'>[]
  systemPrompt: (project: Project, opts: { guide?: string }) => string
  now?: Date
}): Promise<RunOutcome> {
  const { config, routine: r, projects, accounts, sessions } = opts
  const at = opts.now ?? new Date()
  const home = config.home
  const skip = async (reason: string): Promise<RunOutcome> => {
    await recordRun(home, {
      routine: r.name,
      at: at.getTime(),
      status: 'skipped',
      reason,
      prompt: promptHash(r.prompt),
    })
    return { status: 'skipped', reason }
  }
  const project = projects.find((p) => p.key === r.project)
  if (!project) return skip(`no project ${r.project}`)
  const previous = (await listRuns(home, r.name)).find((x) => x.status === 'started')
  if (previous?.id && sessions.find((s) => s.id === previous.id)?.state === 'working') {
    return skip('the previous run is still going')
  }
  // A check that passes needs no model at all, and leaves no report: the run log says it passed.
  let prompt = r.prompt
  if (r.check) {
    const check = await runCheck(r.check, project.runIn)
    if (check.ok) {
      await recordRun(home, {
        routine: r.name,
        at: at.getTime(),
        status: 'passed',
        prompt: promptHash(r.prompt),
      })
      return { status: 'passed' }
    }
    prompt = [
      r.prompt,
      `The check \`${r.check}\` failed (exit ${check.code}) in ${project.runIn}. The end of its output:`,
      '```',
      check.output,
      '```',
    ].join('\n\n')
  }

  // Skip rather than start on an account that is near its limit.
  const route = routeFor(config, r.project)
  const only = !route && config.accounts.length === 1 ? config.accounts[0] : undefined
  const names = route?.accounts ?? (only ? [only.name] : [])
  const account = names
    .map((n) => config.accounts.find((a) => a.name === n))
    .find((a) => a && hasRoom(accounts.find((s) => s.account.name === a.name)))
  if (!account)
    return skip(
      names.length
        ? `every account for ${r.project} is full or signed out`
        : `no account runs ${r.project}`,
    )

  const result = resultPath(home, r.name, at)
  await mkdir(join(routinesDir(home), r.name, 'runs'), { recursive: true })
  const { model, effort } = chosen(r, defaultsFor(config, project))
  const when = at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  const name = `↻ ${r.name} · ${when} ${at.toTimeString().slice(0, 5)}`
  const folder = join(routinesDir(home), r.name)
  const perms = unattendedPermissions(model, [folder])
  const id = await startBackground(account, {
    cwd: project.runIn,
    name,
    prompt,
    systemPrompt: [
      opts.systemPrompt(project, { guide: guidePath(home) }),
      routineInstructions(r, result, previous?.result),
      perms.allowedTools ? limitedNote([folder]) : '',
    ]
      .filter(Boolean)
      .join(' '),
    model,
    effort,
    // Unattended, so never in the checkout something else may be editing.
    worktree: true,
    // The result file sits outside the project; let the run write there without asking.
    // The whole routines folder, so routines can share what they remember (mail-brief's ledger).
    addDirs: [routinesDir(home), ...extraDirs(project), ...lookAcross(r, projects)],
    ...perms,
  })
  await recordConversation(home, id, {
    project: project.key,
    routine: r.name,
    startedAt: at.getTime(),
    unattended: true,
    result,
    model,
    effort,
    worktree: true,
  })
  await recordRun(home, {
    routine: r.name,
    at: at.getTime(),
    status: 'started',
    id,
    account: account.name,
    result,
    prompt: promptHash(r.prompt),
    model,
  })
  return { status: 'started', id, account: account.name }
}
