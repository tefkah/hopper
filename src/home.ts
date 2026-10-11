import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { parse } from 'smol-toml'

import { WORKTREES } from './config.ts'
import { expandHome, isWithin } from './paths.ts'

// A project Hopper knows about. Keys are folder-like: meta/inbox, bh/news/bulletin.
export type Project = {
  key: string
  // Its own folder: what sessions are matched against, and where the work is.
  path: string
  // Where Claude runs for it, so the conversation sees that folder's CLAUDE.md and conventions:
  // a registry project's meta repo, a home project's home folder, otherwise its own folder.
  runIn: string
  // Its list of open items.
  openFile: string
  // What new conversations here start with, unless the draft says otherwise.
  model?: string
  effort?: string
  worktree?: string
  // Set when the project came from a meta repo's registry: that repo's folder, and the key it
  // uses there (null for the meta repo itself). Its planning rules govern the open file.
  // `link` is the project's symlink inside the repo (projects/<key>), when `just link` made one.
  meta?: { repo: string; key: string | null; link?: string }
}

// A meta repo whose registered projects Hopper lists under a prefix, read
// fresh from its paths.local each time so the registry stays the one source of truth.
export type Source = {
  prefix: string
  repo: string
  // A registry key starting with this segment loses it: strip = "bh" turns bh/atlas into
  // <prefix>/atlas rather than <prefix>/bh/atlas.
  strip?: string
  // "repo" (the default) runs every conversation from the meta repo; "project" from its own folder.
  runIn: 'repo' | 'project'
}

const KEY = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/

export const DEFAULT_PROJECTS = `# Every project Hopper knows about. A key is Hopper's own name for it: rename to reorganise.
# path defaults to <home>/projects/<key>, and open_file to <path>/_open.md. run_in is where Claude
# runs for it: the home folder for projects inside it, otherwise path. model and effort set
# what new conversations here start with (haiku, sonnet, opus, fable; low, medium, high).
#
# A [[source]] lists every project a meta repo has on this machine (its paths.local), under a
# prefix, with open files in its planning/ tree:
#   [[source]]
#   prefix = "bh"
#   repo = "~/Workspace/bh-meta"
#   strip = "bh"   # optional: registry key bh/atlas lists as bh/atlas, not bh/bh/atlas
#   run_in = "project"   # optional: run in each project's folder instead of the meta repo
# A source whose repo isn't on this machine is skipped.
# A [[project]] with the same key as an imported one adds to it (say, a model).

[[project]]
key = "meta/inbox"
`

export function parseProjects(text: string, home: string, imported: Project[] = []): Project[] {
  const raw = parse(text) as { project?: unknown }
  const list = Array.isArray(raw.project) ? raw.project : []
  const seen = new Set<string>()
  const byKey = new Map(imported.map((p) => [p.key, p]))
  const own = list.map((entry, i) => {
    const p = (entry ?? {}) as Record<string, unknown>
    const key = p['key']
    if (typeof key !== 'string' || !KEY.test(key)) {
      throw new Error(`projects.toml entry ${i + 1}: key must look like "meta/inbox"`)
    }
    if (seen.has(key)) throw new Error(`projects.toml: "${key}" appears twice`)
    seen.add(key)
    const base = byKey.get(key)
    const path =
      typeof p['path'] === 'string'
        ? expandHome(p['path'])
        : (base?.path ?? join(home, 'projects', key))
    const openFile =
      typeof p['open_file'] === 'string'
        ? expandHome(p['open_file'])
        : (base?.openFile ?? join(path, '_open.md'))
    const runIn =
      typeof p['run_in'] === 'string'
        ? expandHome(p['run_in'])
        : (base?.runIn ?? (isWithin(path, home) ? home : path))
    const project: Project = { ...base, key, path, runIn, openFile }
    if (typeof p['model'] === 'string' && p['model']) project.model = p['model']
    if (typeof p['effort'] === 'string' && p['effort']) project.effort = p['effort']
    const worktree =
      typeof p['worktree'] === 'boolean' ? (p['worktree'] ? 'yes' : 'no') : p['worktree']
    if (WORKTREES.includes(worktree as never)) project.worktree = worktree as string
    return project
  })
  return [...own, ...imported.filter((p) => !seen.has(p.key))]
}

export function parseSources(text: string): Source[] {
  const raw = parse(text) as { source?: unknown }
  const list = Array.isArray(raw.source) ? raw.source : []
  return list.map((entry, i) => {
    const s = (entry ?? {}) as Record<string, unknown>
    const prefix = s['prefix']
    const repo = s['repo']
    if (typeof prefix !== 'string' || !KEY.test(prefix)) {
      throw new Error(`projects.toml source ${i + 1}: prefix must look like "bh"`)
    }
    if (typeof repo !== 'string' || !repo) {
      throw new Error(`projects.toml source ${i + 1}: repo is the meta repo's folder`)
    }
    const runIn = s['run_in'] ?? 'repo'
    if (runIn !== 'repo' && runIn !== 'project') {
      throw new Error(`projects.toml source ${i + 1}: run_in is "repo" or "project"`)
    }
    const source: Source = { prefix, repo: expandHome(repo), runIn }
    if (typeof s['strip'] === 'string' && s['strip']) source.strip = s['strip']
    return source
  })
}

// paths.local is `key=path` per line, # for comments. Keys Hopper can't use are left out
// rather than failing the whole list.
export function parsePathsLocal(text: string): { key: string; path: string }[] {
  const out: { key: string; path: string }[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 1) continue
    const key = t.slice(0, eq).trim()
    const path = t.slice(eq + 1).trim()
    if (KEY.test(key) && path) out.push({ key, path: expandHome(path) })
  }
  return out
}

// Every project a source has checked out here, plus the meta repo itself as <prefix>/meta.
// Paths are resolved through symlinks, because Claude reports a session's physical cwd.
export async function loadSource(source: Source): Promise<Project[]> {
  const repo = await realpath(source.repo)
  const entries = parsePathsLocal(await readFile(join(repo, 'paths.local'), 'utf8'))
  const rename = (key: string) =>
    source.strip && key.startsWith(source.strip + '/') ? key.slice(source.strip.length + 1) : key
  const found = await Promise.all(
    entries.map(async ({ key, path }): Promise<Project | null> => {
      const real = await realpath(path).catch(() => null)
      if (!real) return null
      const link = join(repo, 'projects', key)
      const linked = (await realpath(link).catch(() => null)) === real
      return {
        key: `${source.prefix}/${rename(key)}`,
        path: real,
        runIn: source.runIn === 'repo' ? repo : real,
        openFile: join(repo, 'planning', key, '_open.md'),
        meta: linked ? { repo, key, link } : { repo, key },
      }
    }),
  )
  const meta: Project = {
    key: `${source.prefix}/meta`,
    path: repo,
    runIn: repo,
    openFile: '',
    meta: { repo, key: null },
  }
  return [meta, ...found.filter((p) => p !== null)]
}

// Folders outside where Claude runs that a conversation needs without asking: the project's
// own folder (reached through a symlink, it resolves outside) and where its open file is.
export function extraDirs(project: Project): string[] {
  const dirs = [project.path]
  if (project.openFile) dirs.push(dirname(project.openFile))
  const out: string[] = []
  for (const d of dirs) {
    if (isWithin(d, project.runIn) || out.some((o) => isWithin(d, o))) continue
    out.push(d)
  }
  return out
}

export async function loadProjects(home: string): Promise<Project[]> {
  const text = await readFile(join(home, 'projects.toml'), 'utf8')
  const imported: Project[] = []
  for (const source of parseSources(text)) {
    try {
      imported.push(...(await loadSource(source)))
    } catch (e) {
      // Not checked out on this machine: the home folder syncs, the meta repos may not.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error(`projects.toml source ${source.prefix}: ${(e as Error).message}`)
    }
  }
  const projects = parseProjects(text, home, imported)
  const seen = new Set<string>()
  for (const p of projects) {
    if (seen.has(p.key)) throw new Error(`projects.toml: "${p.key}" comes from two places`)
    seen.add(p.key)
  }
  return projects
}

// Open items are unchecked task lines, the usual `_open.md` shape: `- [ ] **Title** — body`.
export function countOpen(markdown: string): number {
  let n = 0
  for (const line of markdown.split('\n')) if (/^\s*[-*] \[ \] /.test(line)) n++
  return n
}

export async function readOpenCount(project: Project): Promise<number | null> {
  try {
    return countOpen(await readFile(project.openFile, 'utf8'))
  } catch {
    return null
  }
}

const HOME_README = `# Hopper home

Hopper's own state. Not a git repo.

- \`projects.toml\`: every project Hopper knows about
- \`projects/<key>/_open.md\`: open items for projects that live here (the meta/ ones)
- \`state/\`: Hopper's log
`

async function writeIfMissing(path: string, text: string): Promise<boolean> {
  try {
    await writeFile(path, text, { flag: 'wx' })
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
}

// Creates the home folder skeleton. Never overwrites. Returns the paths it created.
export async function initHome(home: string): Promise<string[]> {
  const created: string[] = []
  for (const dir of ['', 'state']) await mkdir(join(home, dir), { recursive: true })
  if (await writeIfMissing(join(home, 'README.md'), HOME_README)) created.push('README.md')
  if (await writeIfMissing(join(home, 'projects.toml'), DEFAULT_PROJECTS))
    created.push('projects.toml')
  for (const project of parseProjects(DEFAULT_PROJECTS, home)) {
    await mkdir(project.path, { recursive: true })
    if (await writeIfMissing(project.openFile, `# ${project.key}\n\n## Open\n`)) {
      created.push(join('projects', project.key, '_open.md'))
    }
  }
  return created
}
