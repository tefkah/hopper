import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { parse, stringify } from 'smol-toml'

import { readIfThere, writeAtomic } from './fsutil.ts'
import { configPath, expandHome, tildify } from './paths.ts'

// Which tool an account drives. Only Claude Code exists today; the field is here so other agent
// CLIs, other clouds and local models can join without rewriting accounts.toml.
export const PROVIDERS = ['claude-code'] as const
export type Provider = (typeof PROVIDERS)[number]

// An account. For Claude Code, `configDir` null means the default login, which must run with
// CLAUDE_CONFIG_DIR unset (see claude.ts).
export type Account = { name: string; label: string; configDir: string | null; provider?: Provider }

// Work under `prefix` runs on the first of `accounts` that is signed in and has room.
// The empty prefix matches every key.
export type Route = { prefix: string; accounts: string[] }

// How Hopper works while nobody is watching: when the night is, how much of the week one night
// may spend, and how far work may run on its own. See dispatch.ts.
export type Overnight = {
  // "22:00-07:00": the window `queue: night` drafts start in.
  window: string
  // Share of the weekly limit one night may use, in points of the week's percentage.
  budget: number
  // The last part of the week kept for the day: nothing starts on its own above 100 - reserve.
  reserve: number
  // Hopper's own unattended conversations running at once, per account.
  maxRunning: number
  // How many links a chain of follow-ups may queue on its own; 0 makes every link wait for a key.
  chainDepth: number
}

export const OVERNIGHT_DEFAULTS: Overnight = {
  window: '22:00-07:00',
  budget: 30,
  reserve: 10,
  maxRunning: 2,
  chainDepth: 2,
}

// config.toml key → Overnight field. Numbers may be written as numbers or strings.
export const OVERNIGHT_KEYS = {
  night: 'window',
  night_budget: 'budget',
  reserve: 'reserve',
  max_running: 'maxRunning',
  chain_depth: 'chainDepth',
} as const satisfies Record<string, keyof Overnight>

export type Config = {
  path: string
  accountsPath: string
  home: string
  // config.toml's sound, when set; see chime.ts.
  sound?: string
  // config.toml's dim, when set: how much darker a panel without the keys is drawn, in percent.
  dim?: number
  // config.toml's model and effort, when set; see defaultsFor.
  model?: string
  effort?: string
  // config.toml's draft_editor, when set: where drafts and routine prompts are written.
  draftEditor?: DraftEditor
  // config.toml's diff_command and nvim_server, when set: what d on a conversation runs in nvim,
  // and a running nvim to run it in. See changes.ts and nvim.ts.
  diffCommand?: string
  nvimServer?: string
  overnight: Overnight
  accounts: Account[]
  routes: Route[]
}

export const DEFAULT_CONFIG = `# Hopper settings. The home folder holds Hopper's own state: the project list, the queue order,
# conversations marked done and its log. It is not a git repo.
home = "~/hopper"

# Played when a conversation stops running and waits on you: a macOS sound (Glass, Ping, Pop,
# Tink, Hero, Submarine, ...), "bell" for the terminal's own, or "off". Glass when not set.
# sound = "Glass"

# How much darker the panels without the keys are drawn, in percent: 0 is not at all, 80 the
# most. Where the terminal has only 256 colours, anything above 0 draws them faint. 38 when not set.
# dim = 38

# The model and effort a conversation starts with when neither it nor its project picks one.
# Hopper always passes both to Claude, so what a conversation runs on doesn't depend on which
# login starts it. opus[1m] (Opus with the 1M-token context) and high when not set.
# model = "opus[1m]"
# effort = "high"

# Where drafts and routine prompts are written (tab, and ⏎ on one): "hopper", its own editor,
# or "external": $VISUAL or $EDITOR (vi when neither is set), with Hopper suspended until it
# exits. o on one opens it there either way. "hopper" when not set.
# draft_editor = "external"

# d on a conversation opens what it changed in nvim: every change since its branch left the
# default branch, committed or not (on the default branch itself, what isn't committed).
# diff_command is the nvim command it runs in the repository's folder; {base} is the commit
# compared with, {dir} the folder, {left} and {right} folders of the files before and now,
# {files} the files the conversation edited itself. Not set, nvim's own DiffTool (0.12 and
# later, no plugin). With diffview.nvim: diff_command = "DiffviewOpen {base}".
# diff_command = "packadd nvim.difftool | DiffTool {left} {right}"
# A running nvim to open it in, as a new tab: one started with --listen on this socket. Not set,
# or not answering, it opens in a new Ghostty window (when Hopper runs in Ghostty on macOS),
# else in Hopper's own terminal until nvim quits.
# nvim_server = "~/.cache/nvim/hopper.sock"

# Overnight: drafts queued for tonight start inside this window, and one night may use up to
# night_budget points of an account's weekly limit, keeping the last reserve points for the day.
# max_running caps Hopper's unattended conversations per account; chain_depth is how many
# follow-ups a run may queue on its own (0: every one waits for you).
# night = "22:00-07:00"
# night_budget = 30
# reserve = 10
# max_running = 2
# chain_depth = 2

# Claude accounts and which prefixes they run are in accounts.toml, next to this file. Hopper
# writes it; manage them from the app (a), or edit it by hand.
`

const ACCOUNTS_HEADER = `# Written by Hopper. Manage from the app (a, for Accounts), or edit by hand.
# config_dir = "default" is the login Claude Code uses with CLAUDE_CONFIG_DIR unset.
# A route sends work under a prefix to the first of its accounts that is signed in and has room.

`

const NAME = /^[a-z0-9][a-z0-9-]{0,11}$/

export class ConfigError extends Error {}

// Accounts are kept in alphabetical order, so every list of them reads the same.
const byName = (a: Account, b: Account) => a.name.localeCompare(b.name)

function tomlError(path: string, e: unknown): ConfigError {
  return new ConfigError(`${tildify(path)}: ${(e as Error).message}`)
}

// "22:00-07:00" → minutes after midnight, or a message saying what's wrong.
export function parseWindow(text: string): { from: number; to: number } | string {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(text)
  const mins = (h: string | undefined, mm: string | undefined) => Number(h) * 60 + Number(mm)
  if (!m || Number(m[1]) > 23 || Number(m[3]) > 23 || Number(m[2]) > 59 || Number(m[4]) > 59)
    return `"${text}": the night is a window like 22:00-07:00`
  return { from: mins(m[1], m[2]), to: mins(m[3], m[4]) }
}

function parseOvernight(raw: Record<string, unknown>, where: string): Overnight {
  const out = { ...OVERNIGHT_DEFAULTS }
  for (const [key, field] of Object.entries(OVERNIGHT_KEYS)) {
    const v = raw[key]
    if (v === undefined) continue
    if (field === 'window') {
      if (typeof v !== 'string' || typeof parseWindow(v) === 'string')
        throw new ConfigError(`${where}: "night" is a window like "22:00-07:00"`)
      out.window = v
      continue
    }
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
    if (!Number.isInteger(n) || n < 0 || n > 100)
      throw new ConfigError(`${where}: "${key}" is a whole number from 0 to 100`)
    out[field] = n
  }
  return out
}

// Where drafts are written: Hopper's own editor, or the person's ($VISUAL, $EDITOR).
export const DRAFT_EDITORS = ['hopper', 'external'] as const
export type DraftEditor = (typeof DRAFT_EDITORS)[number]

// config.toml's dim: Hopper's own amount, and the most it may be. At 100 the text would be black.
export const DIM_DEFAULT = 38
export const DIM_MAX = 80

export function parseSettings(
  text: string,
  path: string,
): {
  home: string
  sound?: string
  dim?: number
  model?: string
  effort?: string
  draftEditor?: DraftEditor
  diffCommand?: string
  nvimServer?: string
  overnight: Overnight
} {
  let raw: Record<string, unknown>
  try {
    raw = parse(text) as Record<string, unknown>
  } catch (e) {
    throw tomlError(path, e)
  }
  const home = raw['home']
  if (typeof home !== 'string' || !home)
    throw new ConfigError(`${tildify(path)}: "home" must be a path`)
  const sound = raw['sound']
  if (sound !== undefined && (typeof sound !== 'string' || !sound))
    throw new ConfigError(`${tildify(path)}: "sound" must be a sound's name, "bell" or "off"`)
  // Written as a number or a string, like the overnight numbers.
  const rawDim = raw['dim']
  const dim =
    typeof rawDim === 'number'
      ? rawDim
      : typeof rawDim === 'string' && rawDim.trim()
        ? Number(rawDim)
        : rawDim === undefined
          ? undefined
          : NaN
  if (dim !== undefined && (!Number.isInteger(dim) || dim < 0 || dim > DIM_MAX))
    throw new ConfigError(`${tildify(path)}: "dim" is a whole number from 0 to ${DIM_MAX}`)
  const choice: { model?: string; effort?: string } = {}
  for (const key of ['model', 'effort'] as const) {
    const v = raw[key]
    if (v === undefined) continue
    if (typeof v !== 'string' || !v)
      throw new ConfigError(
        `${tildify(path)}: "${key}" must be a name like "${CHOICE_DEFAULTS[key]}"`,
      )
    choice[key] = v
  }
  const draftEditor = raw['draft_editor']
  if (draftEditor !== undefined && !DRAFT_EDITORS.includes(draftEditor as DraftEditor))
    throw new ConfigError(`${tildify(path)}: "draft_editor" is "hopper" or "external"`)
  const nvim: { diffCommand?: string; nvimServer?: string } = {}
  for (const [key, field] of [
    ['diff_command', 'diffCommand'],
    ['nvim_server', 'nvimServer'],
  ] as const) {
    const v = raw[key]
    if (v === undefined) continue
    if (typeof v !== 'string' || !v.trim())
      throw new ConfigError(
        `${tildify(path)}: "${key}" must be ${key === 'diff_command' ? 'an nvim command' : "a socket's path"}`,
      )
    nvim[field] = v.trim()
  }
  return {
    home: expandHome(home),
    ...(sound ? { sound } : {}),
    ...(dim !== undefined ? { dim } : {}),
    ...choice,
    ...(draftEditor ? { draftEditor: draftEditor as DraftEditor } : {}),
    ...nvim,
    overnight: parseOvernight(raw, tildify(path)),
  }
}

// What a conversation starts with when it doesn't say. Hopper always passes a model and an
// effort, so "default" names the same thing whichever login runs it, and can always be shown.
export type Choice = { model: string; effort: string }
export const CHOICE_DEFAULTS: Choice = { model: 'opus[1m]', effort: 'high' }

// What a draft or routine in `project` gets for what it leaves unset: the project's own choice,
// else config.toml's, else Hopper's.
export function defaultsFor(
  config: Pick<Config, 'model' | 'effort'>,
  project?: { model?: string | undefined; effort?: string | undefined },
): Choice {
  return {
    model: project?.model ?? config.model ?? CHOICE_DEFAULTS.model,
    effort: project?.effort ?? config.effort ?? CHOICE_DEFAULTS.effort,
  }
}

// What it actually runs with: its own choice where it made one, the defaults for the rest.
export const chosen = (
  own: { model?: string | undefined; effort?: string | undefined },
  defaults: Choice,
): Choice => ({ model: own.model ?? defaults.model, effort: own.effort ?? defaults.effort })

// A model or effort as shown: what was picked, or the default it falls back to, named.
export const choiceText = (own: string | undefined, fallback: string) =>
  own ?? `${fallback} (default)`

// Sets one top-level string in config.toml's text, keeping its comments; null takes it out.
export function setSetting(text: string, key: string, value: string | null): string {
  const line = new RegExp(`^${key}\\s*=.*\\n?`, 'm')
  const next = value === null ? '' : `${key} = ${JSON.stringify(value)}\n`
  if (line.test(text)) return text.replace(line, next)
  return value === null ? text : text.replace(/\n*$/, '\n') + next
}

export function parseAccounts(
  text: string,
  path: string,
): { accounts: Account[]; routes: Route[] } {
  let raw: Record<string, unknown>
  try {
    raw = parse(text) as Record<string, unknown>
  } catch (e) {
    throw tomlError(path, e)
  }
  const where = tildify(path)
  const accounts: Account[] = []
  for (const entry of Array.isArray(raw['account']) ? raw['account'] : []) {
    const a = (entry ?? {}) as Record<string, unknown>
    const name = a['name']
    if (typeof name !== 'string' || !NAME.test(name)) {
      throw new ConfigError(`${where}: account names are 1-12 lowercase letters, digits or hyphens`)
    }
    if (accounts.some((x) => x.name === name))
      throw new ConfigError(`${where}: "${name}" appears twice`)
    const dir = typeof a['config_dir'] === 'string' ? a['config_dir'] : 'default'
    const provider = a['provider'] ?? 'claude-code'
    if (!PROVIDERS.includes(provider as Provider)) {
      throw new ConfigError(
        `${where}: ${name} uses provider "${String(provider)}"; this Hopper knows ${PROVIDERS.join(', ')}`,
      )
    }
    accounts.push({
      name,
      label: typeof a['label'] === 'string' && a['label'] ? a['label'] : name,
      configDir: dir === 'default' ? null : expandHome(dir),
    })
  }
  accounts.sort(byName)
  if (accounts.filter((a) => a.configDir === null).length > 1) {
    throw new ConfigError(`${where}: only one account can use config_dir = "default"`)
  }
  const routes: Route[] = []
  for (const entry of Array.isArray(raw['route']) ? raw['route'] : []) {
    const r = (entry ?? {}) as Record<string, unknown>
    const prefix = typeof r['prefix'] === 'string' ? r['prefix'] : null
    const names = Array.isArray(r['accounts'])
      ? r['accounts'].filter((n): n is string => typeof n === 'string')
      : []
    if (prefix === null) throw new ConfigError(`${where}: every [[route]] needs a prefix`)
    for (const n of names) {
      if (!accounts.some((a) => a.name === n))
        throw new ConfigError(`${where}: route "${prefix}" names an unknown account "${n}"`)
    }
    if (routes.some((x) => x.prefix === prefix))
      throw new ConfigError(`${where}: route "${prefix}" appears twice`)
    if (names.length) routes.push({ prefix, accounts: names })
  }
  return { accounts, routes }
}

export function serializeAccounts(config: Pick<Config, 'accounts' | 'routes'>): string {
  const doc: Record<string, unknown> = {}
  if (config.accounts.length) {
    doc['account'] = config.accounts.map((a) => ({
      name: a.name,
      provider: a.provider ?? 'claude-code',
      label: a.label,
      config_dir: a.configDir === null ? 'default' : tildify(a.configDir),
    }))
  }
  if (config.routes.length) {
    doc['route'] = config.routes.map((r) => ({ prefix: r.prefix, accounts: r.accounts }))
  }
  const body = stringify(doc)
  return ACCOUNTS_HEADER + body + (body && !body.endsWith('\n') ? '\n' : '')
}

export const accountsPathFor = (path: string) => join(dirname(path), 'accounts.toml')

export async function loadConfig(path = configPath()): Promise<Config | null> {
  const text = await readIfThere(path)
  if (text === null) return null
  const accountsPath = accountsPathFor(path)
  const accountsText = await readIfThere(accountsPath)
  const { accounts, routes } =
    accountsText === null ? { accounts: [], routes: [] } : parseAccounts(accountsText, accountsPath)
  return { path, accountsPath, ...parseSettings(text, path), accounts, routes }
}

// Writes the default settings unless they exist. Returns whether it wrote.
export async function writeDefaultConfig(path = configPath()): Promise<boolean> {
  if ((await readIfThere(path)) !== null) return false
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, DEFAULT_CONFIG, { flag: 'wx' })
  return true
}

export const saveAccounts = (config: Config) =>
  writeAtomic(config.accountsPath, serializeAccounts(config))

// ---------- edits: each returns a new Config, or throws ConfigError with a message for the user ----------

export function addAccount(config: Config, account: Account): Config {
  if (!NAME.test(account.name))
    throw new ConfigError('Use 1-12 lowercase letters, digits or hyphens.')
  if (config.accounts.some((a) => a.name === account.name))
    throw new ConfigError(`"${account.name}" is taken.`)
  const clash = config.accounts.find((a) => a.configDir === account.configDir)
  if (clash)
    throw new ConfigError(
      `${clash.name} already uses ${account.configDir === null ? 'the default login' : tildify(account.configDir)}.`,
    )
  return { ...config, accounts: [...config.accounts, account].sort(byName) }
}

export function removeAccount(config: Config, name: string): Config {
  return {
    ...config,
    accounts: config.accounts.filter((a) => a.name !== name),
    routes: config.routes
      .map((r) => ({ ...r, accounts: r.accounts.filter((n) => n !== name) }))
      .filter((r) => r.accounts.length),
  }
}

export function relabel(config: Config, name: string, label: string): Config {
  return {
    ...config,
    accounts: config.accounts.map((a) =>
      a.name === name ? { ...a, label: label.trim() || a.name } : a,
    ),
  }
}

// "bh/, meta" → ["bh/", "meta/"]; "*" means every key.
export function parsePrefixList(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/[,\s]+/)) {
    const p = raw.trim()
    if (!p) continue
    const prefix = p === '*' ? '' : p.endsWith('/') ? p : p + '/'
    if (prefix && !/^[a-z0-9-]+(\/[a-z0-9-]+)*\/$/.test(prefix))
      throw new ConfigError(`"${p}" is not a prefix like bh/ or bh/news/.`)
    if (!out.includes(prefix)) out.push(prefix)
  }
  return out
}

export const showPrefix = (p: string) => (p === '' ? '*' : p)

export function prefixesOf(config: Config, name: string): { prefix: string; rank: number }[] {
  return config.routes.flatMap((r) => {
    const rank = r.accounts.indexOf(name)
    return rank < 0 ? [] : [{ prefix: r.prefix, rank }]
  })
}

// Makes `prefixes` exactly the routes this account is on. New routes put it last, so an
// account joining a pool doesn't jump the queue; `preferFirst` does that on purpose.
export function setPrefixes(config: Config, name: string, prefixes: string[]): Config {
  const routes = config.routes
    .map((r) => {
      const has = r.accounts.includes(name)
      const wants = prefixes.includes(r.prefix)
      if (has && !wants) return { ...r, accounts: r.accounts.filter((n) => n !== name) }
      if (!has && wants) return { ...r, accounts: [...r.accounts, name] }
      return r
    })
    .filter((r) => r.accounts.length)
  for (const p of prefixes)
    if (!routes.some((r) => r.prefix === p)) routes.push({ prefix: p, accounts: [name] })
  routes.sort((a, b) => a.prefix.localeCompare(b.prefix))
  return { ...config, routes }
}

// The default account runs any key no other route covers: it is the route for "" (every key).
export function defaultAccount(config: Config): string | undefined {
  return config.routes.find((r) => r.prefix === '')?.accounts[0]
}

export function setDefaultAccount(config: Config, name: string): Config {
  if (!config.accounts.some((a) => a.name === name)) throw new ConfigError(`No account "${name}".`)
  const others = config.routes.filter((r) => r.prefix !== '')
  const current =
    config.routes.find((r) => r.prefix === '')?.accounts.filter((n) => n !== name) ?? []
  return { ...config, routes: [{ prefix: '', accounts: [name, ...current] }, ...others] }
}

// How a prefix reads to a person: the empty one is everything no other route covers.
export const describePrefix = (p: string) => (p === '' ? 'default' : p)

export function preferFirst(config: Config, name: string): Config {
  return {
    ...config,
    routes: config.routes.map((r) =>
      r.accounts.includes(name)
        ? { ...r, accounts: [name, ...r.accounts.filter((n) => n !== name)] }
        : r,
    ),
  }
}

// A short name from what the login says about itself: "Blue Heron" → bh.
export function suggestName(
  hint: { orgName?: string; email?: string } | null,
  taken: string[],
): string {
  const words = (hint?.orgName ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []
  let base =
    words.length >= 2
      ? words.map((w) => w[0]).join('')
      : (
          words[0] ??
          hint?.email
            ?.split('@')[0]
            ?.toLowerCase()
            .replace(/[^a-z0-9]/g, '') ??
          ''
        ).slice(0, 6)
  if (!base) base = 'claude'
  base = base.slice(0, 10)
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(`${base}${i}`)) return `${base}${i}`
}
