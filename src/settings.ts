// The settings screen's model: every setting in Hopper's three files, what it is now, whether
// it is set or a default, and how to change it. The files stay the truth (like VS Code's
// settings.json); this reads them and writes them back.

import { parse, stringify } from 'smol-toml'

import { DIFF_DEFAULT } from './changes.ts'
import { DEFAULT_SOUND, SOUNDS } from './chime.ts'
import {
  CHOICE_DEFAULTS,
  defaultAccount,
  defaultsFor,
  DIM_DEFAULT,
  OVERNIGHT_DEFAULTS,
  OVERNIGHT_KEYS,
  prefixesOf,
  showPrefix,
  type Config,
} from './config.ts'
import { EFFORTS, MODELS } from './conversations.ts'
import type { Project } from './home.ts'
import { tildify } from './paths.ts'
import { routeFor } from './routing.ts'

// ---------- projects.toml as a document: its header comment, then its tables ----------

type Table = Record<string, unknown>
export type ProjectsDoc = { header: string; project: Table[]; source: Table[] }

export function parseProjectsDoc(text: string): ProjectsDoc {
  const lines = text.split('\n')
  let n = 0
  while (n < lines.length && (lines[n]!.startsWith('#') || !lines[n]!.trim())) n++
  const raw = parse(text) as { project?: unknown; source?: unknown }
  const tables = (v: unknown) => (Array.isArray(v) ? (v as Table[]) : [])
  return {
    header: lines.slice(0, n).join('\n').trimEnd(),
    project: tables(raw.project),
    source: tables(raw.source),
  }
}

// Comments other than the header don't survive a write from the settings screen.
export function serializeProjectsDoc(doc: ProjectsDoc): string {
  const body: Record<string, unknown> = {}
  if (doc.project.length) body['project'] = doc.project
  if (doc.source.length) body['source'] = doc.source
  const text = stringify(body).trim()
  return [doc.header, text].filter(Boolean).join('\n\n') + '\n'
}

export type TableName = 'project' | 'source'

// null removes the field, so it falls back to its default.
export function setField(
  doc: ProjectsDoc,
  table: TableName,
  index: number,
  field: string,
  value: string | null,
): ProjectsDoc {
  const rows = doc[table].map((t, i) => {
    if (i !== index) return t
    const next = { ...t }
    if (value === null || value === '') delete next[field]
    else next[field] = value
    return next
  })
  return { ...doc, [table]: rows }
}

export const addEntry = (doc: ProjectsDoc, table: TableName, entry: Table): ProjectsDoc => ({
  ...doc,
  [table]: [...doc[table], entry],
})

export const removeEntry = (doc: ProjectsDoc, table: TableName, index: number): ProjectsDoc => ({
  ...doc,
  [table]: doc[table].filter((_, i) => i !== index),
})

// ---------- rows ----------

export type Target =
  | {
      file: 'config'
      field:
        | 'home'
        | 'sound'
        | 'dim'
        | 'model'
        | 'effort'
        | 'draft_editor'
        | 'diff_command'
        | 'nvim_server'
        | keyof typeof OVERNIGHT_KEYS
    }
  | { file: 'accounts'; account: string; field: 'label' | 'prefixes' | 'default' }
  | { file: 'projects'; table: TableName; index: number; field: string }

// '' in options is "not set": the default, which `fallback` names where it has a name.
export type Edit =
  | { type: 'text' }
  | { type: 'choice'; options: string[]; fallback?: string }
  | { type: 'readonly' }

export type FileKey = 'config' | 'accounts' | 'projects'

export type Row =
  | { kind: 'section'; id: string; label: string; file: FileKey; help: string; add?: FileKey }
  | { kind: 'group'; id: string; label: string; help: string; file: FileKey; remove?: Target }
  | {
      kind: 'setting'
      id: string
      label: string
      // What it is now, set or not, as shown; and what the file holds ('' when not set).
      value: string
      raw: string
      isSet: boolean
      help: string
      file: FileKey
      edit: Edit
      target: Target
      warn?: string
    }

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const modelOptions = MODELS.map((m) => m ?? '')
const effortOptions = EFFORTS.map((m) => m ?? '')
// config.toml's choices: '' is Hopper's own default, so it isn't listed again under its name.
const hopperOptions = (list: readonly (string | undefined)[], def: string) => [
  '',
  ...list.filter((m): m is string => !!m && m !== def),
]
// '' is the default sound, so it isn't listed again under its name.
const soundOptions = ['', ...SOUNDS.filter((s) => s !== DEFAULT_SOUND)]
// From the default upwards, then round through off: ⏎ always steps darker until it wraps.
const dimOptions = ['', '50', '65', '80', '0', '20']
const dimText = (n: number) => (n === 0 ? '0 (off)' : String(n))

export function buildRows(
  config: Config,
  doc: ProjectsDoc | null,
  projects: Project[],
  missingSources: string[],
): Row[] {
  const rows: Row[] = []

  rows.push({
    kind: 'section',
    id: 'general',
    label: 'General',
    file: 'config',
    help: 'Where Hopper keeps its own state. config.toml.',
  })
  rows.push({
    kind: 'setting',
    id: 'general.home',
    label: 'home folder',
    value: tildify(config.home),
    raw: tildify(config.home),
    isSet: true,
    help: 'The folder holding the project list, drafts, routines, done marks and meta/ projects. meta/ conversations run from here. To move it, move the folder and change it in config.toml (o opens it).',
    file: 'config',
    edit: { type: 'readonly' },
    target: { file: 'config', field: 'home' },
  })
  rows.push({
    kind: 'setting',
    id: 'general.sound',
    label: 'sound',
    value: config.sound ?? DEFAULT_SOUND,
    raw: config.sound ?? '',
    isSet: !!config.sound,
    help: 'Played when a conversation stops running and waits on you, unless it is the one open on the right. A macOS sound, bell for the terminal’s own, or off. ⏎ plays the next one.',
    file: 'config',
    edit: { type: 'choice', options: soundOptions, fallback: DEFAULT_SOUND },
    target: { file: 'config', field: 'sound' },
  })
  rows.push({
    kind: 'setting',
    id: 'general.dim',
    label: 'dim',
    value: config.dim === undefined ? `${DIM_DEFAULT} (default)` : dimText(config.dim),
    raw: config.dim === undefined ? '' : String(config.dim),
    isSet: config.dim !== undefined,
    help: 'How much darker the panels without the keys are drawn, in percent, so the eye goes to the one that has them. 0 is not at all, 80 the most. Where the terminal has only 256 colours, anything above 0 draws them faint.',
    file: 'config',
    edit: { type: 'choice', options: dimOptions, fallback: String(DIM_DEFAULT) },
    target: { file: 'config', field: 'dim' },
  })
  const choiceHelp = {
    model:
      'The model a conversation starts with when neither it nor its project picks one. Hopper always tells Claude which, so it is the same on every login.',
    effort: 'The effort a conversation starts with when neither it nor its project picks one.',
  }
  for (const key of ['model', 'effort'] as const) {
    rows.push({
      kind: 'setting',
      id: `general.${key}`,
      label: key,
      value: config[key] ?? `${CHOICE_DEFAULTS[key]} (default)`,
      raw: config[key] ?? '',
      isSet: !!config[key],
      help: choiceHelp[key],
      file: 'config',
      edit: {
        type: 'choice',
        options: hopperOptions(key === 'model' ? MODELS : EFFORTS, CHOICE_DEFAULTS[key]),
        fallback: CHOICE_DEFAULTS[key],
      },
      target: { file: 'config', field: key },
    })
  }
  rows.push({
    kind: 'setting',
    id: 'general.draft_editor',
    label: 'draft editor',
    value: config.draftEditor ?? 'hopper (default)',
    raw: config.draftEditor ?? '',
    isSet: !!config.draftEditor,
    help: 'Where drafts and routine prompts are written, from tab or ⏎ on one: hopper, its own editor, or external, your $VISUAL or $EDITOR (vi when neither is set), with Hopper suspended until it exits. o on one opens it there either way.',
    file: 'config',
    edit: { type: 'choice', options: ['', 'external'], fallback: 'hopper' },
    target: { file: 'config', field: 'draft_editor' },
  })

  // d on a conversation: what it changed, in nvim.
  rows.push({
    kind: 'setting',
    id: 'general.diff_command',
    label: 'diff command',
    value: config.diffCommand ?? DIFF_DEFAULT,
    raw: config.diffCommand ?? '',
    isSet: !!config.diffCommand,
    help: 'What d on a conversation runs in nvim, in the folder it worked in, to show what it changed: everything since its branch left the default branch, committed or not (on the default branch itself, what isn’t committed). {base} is the commit compared with, {dir} the folder, {left} and {right} folders of the changed files before and now, {files} the files the conversation edited itself. The default is nvim’s own DiffTool (0.12 and later, no plugin); with diffview.nvim, DiffviewOpen {base}.',
    file: 'config',
    edit: { type: 'text' },
    target: { file: 'config', field: 'diff_command' },
  })
  rows.push({
    kind: 'setting',
    id: 'general.nvim_server',
    label: 'nvim server',
    value: config.nvimServer ?? '',
    raw: config.nvimServer ?? '',
    isSet: !!config.nvimServer,
    help: 'A running nvim to open changes in, as a new tab: the socket it listens on (nvim --listen ~/.cache/nvim/hopper.sock). When it isn’t answering, d opens a new Ghostty window if Hopper runs in Ghostty on macOS, else nvim takes Hopper’s terminal until it quits.',
    file: 'config',
    edit: { type: 'text' },
    target: { file: 'config', field: 'nvim_server' },
  })

  rows.push({
    kind: 'section',
    id: 'overnight',
    label: 'Overnight',
    file: 'config',
    help: 'How queued work runs while you are away: drafts queued for tonight (u on a draft) start inside the night, unattended, within a budget. config.toml.',
  })
  const OVERNIGHT_HELP: Record<keyof typeof OVERNIGHT_KEYS, string> = {
    night: 'The night window, like 22:00-07:00. Drafts queued for tonight start only inside it.',
    night_budget:
      "How many points of an account's weekly limit one night may use. Dispatch stops starting work once the week has risen this much since the night began.",
    reserve:
      'The last points of the week kept for the day: nothing starts on its own once an account is past 100 minus this.',
    max_running: "Hopper's unattended conversations running at once, per account.",
    chain_depth:
      'How many follow-ups a run may queue on its own, one after another. Past it they are proposed for you instead; 0 makes every one wait for you.',
  }
  for (const [key, field] of Object.entries(OVERNIGHT_KEYS) as [
    keyof typeof OVERNIGHT_KEYS,
    (typeof OVERNIGHT_KEYS)[keyof typeof OVERNIGHT_KEYS],
  ][]) {
    const value = String(config.overnight[field])
    const isSet = value !== String(OVERNIGHT_DEFAULTS[field])
    rows.push({
      kind: 'setting',
      id: `overnight.${key}`,
      label: key.replace(/_/g, ' '),
      value,
      raw: isSet ? value : '',
      isSet,
      help: OVERNIGHT_HELP[key],
      file: 'config',
      edit: { type: 'text' },
      target: { file: 'config', field: key },
    })
  }

  rows.push({
    kind: 'section',
    id: 'accounts',
    label: 'Accounts',
    file: 'accounts',
    add: 'accounts',
    help: 'Claude logins, and which keys each runs. A key runs on the first signed-in account with room on the longest matching prefix; the default runs everything else. accounts.toml.',
  })
  const def = defaultAccount(config)
  // Keys no account would run: with more than one account, Hopper won't guess.
  if (config.accounts.length > 1) {
    const tops = [...new Set(projects.map((p) => p.key.split('/')[0] ?? ''))]
    const uncovered = tops.filter((t) => !routeFor(config, `${t}/x`)).map((t) => `${t}/`)
    if (uncovered.length) {
      rows.push({
        kind: 'group',
        id: 'accounts.uncovered',
        label: `! nothing runs ${uncovered.join(', ')}`,
        help: `No account runs ${uncovered.join(', ')}, so conversations there won't start. Make one account the default (it runs everything no prefix names), or add these to an account's runs.`,
        file: 'accounts',
      })
    }
  }
  for (const a of config.accounts) {
    const prefixes = prefixesOf(config, a.name).filter((p) => p.prefix !== '')
    rows.push({
      kind: 'group',
      id: `account.${a.name}`,
      label: a.label === a.name ? a.name : `${a.name} · ${a.label}`,
      help: 'd removes it from Hopper; its login and sessions stay.',
      file: 'accounts',
      remove: { file: 'accounts', account: a.name, field: 'label' },
    })
    rows.push({
      kind: 'setting',
      id: `account.${a.name}.label`,
      label: 'label',
      value: a.label,
      raw: a.label,
      isSet: a.label !== a.name,
      help: 'What Hopper calls it on screen.',
      file: 'accounts',
      edit: { type: 'text' },
      target: { file: 'accounts', account: a.name, field: 'label' },
    })
    rows.push({
      kind: 'setting',
      id: `account.${a.name}.dir`,
      label: 'config folder',
      value: a.configDir === null ? 'default (CLAUDE_CONFIG_DIR unset)' : tildify(a.configDir),
      raw: '',
      isSet: true,
      help: 'The Claude Code config folder its login lives in. To change it, add the account again.',
      file: 'accounts',
      edit: { type: 'readonly' },
      target: { file: 'accounts', account: a.name, field: 'label' },
    })
    rows.push({
      kind: 'setting',
      id: `account.${a.name}.prefixes`,
      label: 'runs',
      value: prefixes
        .map((p) => `${showPrefix(p.prefix)}${p.rank ? ` (#${p.rank + 1})` : ''}`)
        .join(', '),
      raw: prefixes.map((p) => showPrefix(p.prefix)).join(', '),
      isSet: prefixes.length > 0,
      help: 'Key prefixes it runs, comma separated: bh/, pm/. (#2) means another account is ahead of it on that prefix.',
      file: 'accounts',
      edit: { type: 'text' },
      target: { file: 'accounts', account: a.name, field: 'prefixes' },
    })
    rows.push({
      kind: 'setting',
      id: `account.${a.name}.default`,
      label: 'default',
      value: def === a.name ? 'yes' : 'no',
      raw: def === a.name ? 'yes' : 'no',
      isSet: def === a.name,
      help: 'The default account runs any key no prefix covers, meta/ included unless a route names it.',
      file: 'accounts',
      edit: { type: 'choice', options: ['no', 'yes'] },
      target: { file: 'accounts', account: a.name, field: 'default' },
    })
  }

  const counts = new Map<string, number>()
  for (const p of projects) {
    const top = p.meta ? (p.key.split('/')[0] ?? '') : 'home folder'
    counts.set(top, (counts.get(top) ?? 0) + 1)
  }
  const tally = [...counts].map(
    ([k, n]) => `${n} ${k === 'home folder' ? 'in the home folder' : `from ${k}/`}`,
  )

  rows.push({
    kind: 'section',
    id: 'sources',
    label: 'Sources',
    file: 'projects',
    add: 'projects',
    help: 'Meta repos whose registered projects Hopper lists, read from their paths.local every time. projects.toml.',
  })
  ;(doc?.source ?? []).forEach((s, i) => {
    const prefix = str(s['prefix'])
    const repo = str(s['repo'])
    const t = (field: string): Target => ({ file: 'projects', table: 'source', index: i, field })
    const missing = missingSources.includes(prefix)
    rows.push({
      kind: 'group',
      id: `source.${i}`,
      label: `${prefix}/ · ${repo}`,
      help: missing
        ? 'Not on this machine, so it adds nothing here. d removes it.'
        : 'd removes it; its projects leave the list.',
      file: 'projects',
      remove: t('prefix'),
    })
    rows.push({
      kind: 'setting',
      id: `source.${i}.prefix`,
      label: 'prefix',
      value: prefix,
      raw: prefix,
      isSet: true,
      help: `Its projects are listed under ${prefix}/. Routes pick accounts by it.`,
      file: 'projects',
      edit: { type: 'text' },
      target: t('prefix'),
    })
    rows.push({
      kind: 'setting',
      id: `source.${i}.repo`,
      label: 'repo',
      value: repo,
      raw: repo,
      isSet: true,
      help: 'The meta repo: the folder holding paths.local, planning/ and projects/.',
      file: 'projects',
      edit: { type: 'text' },
      target: t('repo'),
      ...(missing ? { warn: 'not on this machine' } : {}),
    })
    rows.push({
      kind: 'setting',
      id: `source.${i}.strip`,
      label: 'strip',
      value: str(s['strip']),
      raw: str(s['strip']),
      isSet: !!str(s['strip']),
      help: `A registry key starting with this segment loses it: with "${prefix}", ${prefix}/atlas lists as ${prefix}/atlas rather than ${prefix}/${prefix}/atlas. Blank keeps every key whole.`,
      file: 'projects',
      edit: { type: 'text' },
      target: t('strip'),
    })
    rows.push({
      kind: 'setting',
      id: `source.${i}.run_in`,
      label: 'run in',
      value: str(s['run_in']) || 'repo',
      raw: str(s['run_in']),
      isSet: !!str(s['run_in']),
      help: 'repo: every conversation runs from the meta repo, so its CLAUDE.md and conventions apply, and reaches the code through its projects/ link. project: each runs in its own folder.',
      file: 'projects',
      edit: { type: 'choice', options: ['', 'project'], fallback: 'repo' },
      target: t('run_in'),
    })
  })

  rows.push({
    kind: 'section',
    id: 'projects',
    label: 'Projects',
    file: 'projects',
    add: 'projects',
    help: `${projects.length} projects: ${tally.join(', ')}. A [[project]] here adds a project to the home folder, or sets things for one a source lists. projects.toml.`,
  })
  ;(doc?.project ?? []).forEach((p, i) => {
    const key = str(p['key'])
    const live = projects.find((x) => x.key === key)
    const t = (field: string): Target => ({ file: 'projects', table: 'project', index: i, field })
    const imported = !!live?.meta
    rows.push({
      kind: 'group',
      id: `project.${i}`,
      label: key,
      help: imported
        ? `Settings for a project from ${key.split('/')[0]}/. d removes them; the project stays.`
        : 'A project in the home folder. d removes it from the list; its folder stays.',
      file: 'projects',
      remove: t('key'),
    })
    const field = (
      name: string,
      label: string,
      value: string,
      help: string,
      edit: Edit = { type: 'text' },
    ) =>
      rows.push({
        kind: 'setting',
        id: `project.${i}.${name}`,
        label,
        value,
        raw: str(p[name]),
        isSet: !!str(p[name]),
        help,
        file: 'projects',
        edit,
        target: t(name),
      })
    field(
      'path',
      'folder',
      tildify(live?.path ?? str(p['path'])),
      'Its own folder: where the code is, and what sessions started outside Hopper are matched against.',
    )
    field(
      'run_in',
      'run in',
      tildify(live?.runIn ?? str(p['run_in'])),
      'Where Claude runs for it, so it sees that folder’s CLAUDE.md. Defaults to the meta repo for a source’s projects, the home folder for home projects.',
    )
    field(
      'open_file',
      'open items',
      tildify(live?.openFile ?? str(p['open_file'])),
      'The _open.md its open items live in.',
    )
    field(
      'model',
      'model',
      str(p['model']) || `${defaultsFor(config).model} (default)`,
      'What new conversations here start with, unless the draft says otherwise. Not set, the model in General.',
      {
        type: 'choice',
        options: modelOptions,
        fallback: defaultsFor(config).model,
      },
    )
    field(
      'effort',
      'effort',
      str(p['effort']) || `${defaultsFor(config).effort} (default)`,
      'The effort new conversations here start with. Not set, the effort in General.',
      {
        type: 'choice',
        options: effortOptions,
        fallback: defaultsFor(config).effort,
      },
    )
  })
  return rows
}

// The next option after the current one, wrapping; '' is the default.
export function nextOption(options: string[], current: string): string {
  const i = options.indexOf(current)
  return options[(i + 1) % options.length] ?? ''
}
