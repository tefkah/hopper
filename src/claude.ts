import { execFile, spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Account } from './config.ts'

export type Session = {
  account: string
  // Background sessions have a short id that `claude attach` takes; interactive ones don't.
  id: string | null
  sessionId: string
  // A draft is a conversation Hopper holds that hasn't been started with Claude yet.
  // A routine is its schedule and prompt, shown in the list; its runs are background sessions.
  kind: 'background' | 'interactive' | 'draft' | 'routine'
  cwd: string
  name: string
  startedAt: number
  // Background: working, blocked, done, failed, stopped. Interactive: idle, busy.
  state: string
}

export type Auth = {
  loggedIn: boolean
  email?: string
  orgName?: string
  subscriptionType?: string
  configDirectory?: string
}

export type Window = { pct: number; resetsAt: string | null }
export type Usage = { fiveHour: Window | null; sevenDay: Window | null; fetchedAt: number }

const claudeBin = () => process.env['HOPPER_CLAUDE'] || 'claude'

// The default login only works with CLAUDE_CONFIG_DIR unset: setting it to ~/.claude makes the
// existing login read as logged out. Every other login gets its own directory.
export function envFor(account: Account): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (account.configDir === null) delete env['CLAUDE_CONFIG_DIR']
  else env['CLAUDE_CONFIG_DIR'] = account.configDir
  return env
}

// Where Claude Code keeps a login's settings file, which carries the cached usage.
export function claudeJsonPath(account: Account): string {
  return account.configDir === null
    ? join(homedir(), '.claude.json')
    : join(account.configDir, '.claude.json')
}

// `claude auth status` exits 1 when signed out but still prints its JSON, so a caller can accept
// output from a failed exit.
function run(
  account: Account,
  args: string[],
  opts: { acceptFailure?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      claudeBin(),
      args,
      { env: envFor(account), timeout: 15_000, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => {
        if (!err || (opts.acceptFailure && stdout.trim())) resolve(stdout)
        else reject(new Error((stderr || err.message).trim().split('\n')[0] ?? err.message))
      },
    )
  })
}

// A login whose directory doesn't exist yet has never been set up. Asking claude about it would
// create the directory as a side effect, so don't.
export async function isSetUp(account: Account): Promise<boolean> {
  if (account.configDir === null) return true
  try {
    await access(account.configDir)
    return true
  } catch {
    return false
  }
}

export function parseAuth(json: unknown): Auth {
  const o = (json ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined)
  const auth: Auth = { loggedIn: o['loggedIn'] === true }
  const email = str('email')
  const orgName = str('orgName')
  const subscriptionType = str('subscriptionType')
  const configDirectory = str('configDirectory')
  if (email) auth.email = email
  if (orgName) auth.orgName = orgName
  if (subscriptionType) auth.subscriptionType = subscriptionType
  if (configDirectory) auth.configDirectory = configDirectory
  return auth
}

// `claude agents --json` mixes two shapes: background sessions carry `id` + `state`,
// interactive ones carry `pid` + `status`.
export function parseSessions(json: unknown, account: string): Session[] {
  if (!Array.isArray(json)) return []
  const out: Session[] = []
  for (const item of json) {
    const o = (item ?? {}) as Record<string, unknown>
    const sessionId = typeof o['sessionId'] === 'string' ? o['sessionId'] : null
    const cwd = typeof o['cwd'] === 'string' ? o['cwd'] : null
    if (!sessionId || !cwd) continue
    const background = o['kind'] === 'background' || typeof o['id'] === 'string'
    out.push({
      account,
      id: typeof o['id'] === 'string' ? o['id'] : null,
      sessionId,
      kind: background ? 'background' : 'interactive',
      cwd,
      name: typeof o['name'] === 'string' && o['name'] ? o['name'] : sessionId.slice(0, 8),
      startedAt: typeof o['startedAt'] === 'number' ? o['startedAt'] : 0,
      state: String(o['state'] ?? o['status'] ?? 'unknown'),
    })
  }
  return out
}

function parseWindow(w: unknown): Window | null {
  const o = w as Record<string, unknown> | null
  if (!o || typeof o['utilization'] !== 'number') return null
  return {
    pct: o['utilization'],
    resetsAt: typeof o['resets_at'] === 'string' ? o['resets_at'] : null,
  }
}

// Claude Code caches the login's usage in its settings file. It refreshes only when Claude Code
// fetches it, so it can be days old: always show fetchedAt next to it.
export function parseUsage(claudeJson: unknown): Usage | null {
  const cached = (claudeJson as Record<string, unknown> | null)?.['cachedUsageUtilization'] as
    | Record<string, unknown>
    | undefined
  if (!cached || typeof cached['fetchedAtMs'] !== 'number') return null
  const u = (cached['utilization'] ?? {}) as Record<string, unknown>
  return {
    fiveHour: parseWindow(u['five_hour']),
    sevenDay: parseWindow(u['seven_day']),
    fetchedAt: cached['fetchedAtMs'],
  }
}

export async function fetchAuth(account: Account): Promise<Auth> {
  if (!(await isSetUp(account))) return { loggedIn: false }
  return parseAuth(JSON.parse(await run(account, ['auth', 'status'], { acceptFailure: true })))
}

export async function fetchSessions(account: Account): Promise<Session[]> {
  if (!(await isSetUp(account))) return []
  return parseSessions(JSON.parse(await run(account, ['agents', '--json', '--all'])), account.name)
}

export async function readUsage(account: Account): Promise<Usage | null> {
  try {
    return parseUsage(JSON.parse(await readFile(claudeJsonPath(account), 'utf8')))
  } catch {
    return null
  }
}

// Runs claude with the terminal handed over (attach, login, trust). Resolves with the exit code.
export function runInteractive(account: Account, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), args, {
      env: envFor(account),
      stdio: 'inherit',
      ...(cwd ? { cwd } : {}),
    })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 0))
  })
}

// Claude won't start background work in a folder nobody has trusted yet. Trust covers the
// folders inside it, so trusting Hopper's home once covers every meta/ project.
export class UntrustedError extends Error {
  constructor(readonly dir: string) {
    super(`Claude hasn't been told to trust ${dir} yet`)
  }
}

// Parses "backgrounded · 699f6c71 · name" from `claude --bg`. With colour forced (FORCE_COLOR in
// the environment) the id comes wrapped in escape codes; missing it would report a session that
// started as a failure, and the dispatcher would start it again.
const ESCAPES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')

export function parseBackgroundId(stdout: string): string | null {
  const plain = stdout.replace(ESCAPES, '')
  return /backgrounded\s*·\s*([0-9a-f]{6,})/.exec(plain)?.[1] ?? null
}

// How a session with nobody watching gets its permissions. 'auto' lets Claude decide what's safe
// rather than ask. Some models have no auto mode (Claude Code 2.1.284 says "auto mode
// unavailable for this model" for Haiku and falls back to asking), so those get 'dontAsk':
// anything not allowed here is denied, never asked. They may read, search, look at git history
// and use Hopper's own commands, and write only in `writable`.
export type UnattendedMode = 'auto' | 'dontAsk'
const NO_AUTO = new Set(['haiku'])

export function unattendedPermissions(
  model: string | undefined,
  writable: string[],
): { permissionMode: UnattendedMode; allowedTools?: string[] } {
  if (!model || !NO_AUTO.has(model)) return { permissionMode: 'auto' }
  const read = ['log', 'diff', 'show', 'status', 'branch', 'for-each-ref'].map(
    (c) => `Bash(git ${c}:*)`,
  )
  return {
    permissionMode: 'dontAsk',
    allowedTools: [
      'Read',
      'Glob',
      'Grep',
      ...read,
      'Bash(ls:*)',
      'Bash(hopper list:*)',
      'Bash(hopper draft new:*)',
      // An absolute path in a rule starts with //.
      ...writable.map((d) => `Edit(/${d}/**)`),
    ],
  }
}

// What a run with limited permissions is told, so it doesn't spend itself retrying denials.
export const limitedNote = (writable: string[]) =>
  `This run's model has no auto mode, so its permissions are limited: it may read and search files, run git log, diff, show, status and branch, ls, and hopper list and hopper draft new, and write only under ${writable.join(', ')}. Anything else is denied without asking; don't retry it, say in the result what you couldn't do.`

// Starts a conversation as a Claude Code background session and returns its short id.
export function startBackground(
  account: Account,
  opts: {
    cwd: string
    name: string
    prompt: string
    systemPrompt?: string
    model?: string | undefined
    effort?: string | undefined
    // Whether it enters a git worktree before it edits, or edits cwd in place.
    worktree?: boolean | undefined
    // Folders outside cwd the session may use without asking (a routine's result folder).
    addDirs?: string[] | undefined
    // With nobody watching, never a mode that asks (see unattendedPermissions).
    permissionMode?: UnattendedMode | undefined
    allowedTools?: string[] | undefined
  },
): Promise<string> {
  // Remote Control puts the session in the Claude app too, so it can be answered from the phone.
  const args = ['--bg', '--name', opts.name, '--remote-control', opts.name]
  // --allowedTools takes every value up to the next flag, so one always follows it.
  if (opts.allowedTools?.length) args.push('--allowedTools', ...opts.allowedTools)
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode)
  for (const d of opts.addDirs ?? []) args.push('--add-dir', d)
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push('--effort', opts.effort)
  // Left off, a background session must enter a worktree before Claude lets it edit.
  if (opts.worktree !== undefined) {
    const bgIsolation = opts.worktree ? 'worktree' : 'none'
    args.push('--settings', JSON.stringify({ worktree: { bgIsolation } }))
  }
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt)
  args.push(opts.prompt)
  return new Promise((resolve, reject) => {
    execFile(
      claudeBin(),
      args,
      { cwd: opts.cwd, env: envFor(account), timeout: 60_000 },
      (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`
        if (/not trusted/i.test(out)) return reject(new UntrustedError(opts.cwd))
        const id = parseBackgroundId(out)
        if (id) return resolve(id)
        reject(
          new Error(
            (stderr || err?.message || stdout || 'claude --bg printed no id').trim().split('\n')[0],
          ),
        )
      },
    )
  })
}

// Asks Claude Code for the account's usage. /usage is answered locally (no model turn, no cost)
// and refreshes the cached numbers readUsage() reads, so Hopper never touches the login token.
// Resolves with Claude's own summary text.
export function refreshUsage(account: Account, cwd: string): Promise<string> {
  const args = ['-p', '/usage', '--output-format', 'json', '--no-session-persistence']
  return new Promise((resolve, reject) => {
    execFile(
      claudeBin(),
      args,
      { cwd, env: envFor(account), timeout: 60_000 },
      (err, stdout, stderr) => {
        try {
          const out = JSON.parse(stdout) as { result?: string }
          resolve(typeof out.result === 'string' ? out.result : '')
        } catch {
          reject(
            new Error((stderr || err?.message || 'no answer from /usage').trim().split('\n')[0]),
          )
        }
      },
    )
  })
}

// The limit lines from /usage, e.g. "Current week (Fable): 0% used · resets Sep 30 at 11pm".
export function usageLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^current /i.test(l) && /% used/.test(l))
}
