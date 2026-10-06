import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import { isWithin, tildify } from './paths.ts'

// What a conversation changed, for d: the repository it worked in, and what to compare that with.
// Its own branch, usually in a worktree Claude Code made, is compared with where it left the
// default branch, so everything since shows, committed or not. Working on the default branch
// itself, only what isn't committed yet shows.

// A message for the person: why there's nothing to open.
export class ChangesError extends Error {}

// ---------- the transcript: where it worked, and what it edited ----------

export type Worked = {
  // The folder the session last reported, or null when none says. A session that enters a
  // worktree, or cds somewhere, carries on there.
  cwd: string | null
  // Files it wrote with Edit, Write, MultiEdit or NotebookEdit, oldest first, each once.
  edited: string[]
}

const CWD = /"cwd":("(?:[^"\\]|\\.)*")/
const EDITS = /"name":"(?:Edit|Write|MultiEdit|NotebookEdit)"/
const SIDECHAIN = /"isSidechain":true/

type Block = {
  type?: string
  name?: string
  input?: { file_path?: string; notebook_path?: string }
}

// Reads the whole transcript once, line by line: it's for a key press, not a poll.
export async function readWorked(path: string): Promise<Worked> {
  let cwd: string | null = null
  const edited: string[] = []
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      // A subagent's turns (in older transcripts, inline) say where it was, not the session.
      if (SIDECHAIN.test(line)) continue
      const c = CWD.exec(line)?.[1]
      if (c) {
        try {
          cwd = JSON.parse(c) as string
        } catch {}
      }
      if (!EDITS.test(line)) continue
      let entry: { message?: { content?: unknown } }
      try {
        entry = JSON.parse(line) as typeof entry
      } catch {
        continue
      }
      const content = entry.message?.content
      for (const b of Array.isArray(content) ? (content as Block[]) : []) {
        if (b?.type !== 'tool_use') continue
        const file = b.input?.file_path ?? b.input?.notebook_path
        if (typeof file !== 'string' || !file.startsWith('/')) continue
        const at = edited.indexOf(file)
        if (at >= 0) edited.splice(at, 1)
        edited.push(file)
      }
    }
  } catch {
    // A transcript that can't be read says nothing.
  } finally {
    lines.close()
  }
  return { cwd, edited }
}

// ---------- git ----------

export type Git = (dir: string, args: string[]) => Promise<string>

export const git: Git = (dir, args) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', dir, ...args],
      { maxBuffer: 64 << 20, timeout: 20_000, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim().split('\n')[0] ?? err.message))
        else resolve(stdout)
      },
    )
  })

const gitOr = (run: Git, dir: string, args: string[]) =>
  run(dir, args).then(
    (out) => out.trim(),
    () => null,
  )

const isDir = (p: string) =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  )

const topOf = async (run: Git, dir: string) => gitOr(run, dir, ['rev-parse', '--show-toplevel'])

// The repositories it worked in, the likeliest first: the ones it edited files in, most files
// first and the newest on a tie, then where the session last was. Usually they're the same; they
// differ for a session in a meta repo that works on a project's worktree by its path, or that cds
// back before it stops, or one in a worktree that only edits planning files elsewhere. Throws when
// none is left: the folder is gone or isn't in git.
export async function workedIn(
  worked: Worked,
  started: string,
  run: Git = git,
): Promise<string[]> {
  const cwd = worked.cwd ?? started
  const here = (await isDir(cwd)) ? await topOf(run, cwd) : null
  const counts = new Map<string, { n: number; last: number }>()
  const tops = new Map<string, string | null>()
  for (const [i, file] of worked.edited.entries()) {
    // Its own folder, not the nearest one left: with the worktree removed, that would be the
    // main checkout, which isn't what it changed.
    const folder = dirname(file)
    if (!tops.has(folder))
      tops.set(folder, (await isDir(folder)) ? await topOf(run, await realpath(folder)) : null)
    const top = tops.get(folder)
    if (!top) continue
    counts.set(top, { n: (counts.get(top)?.n ?? 0) + 1, last: i })
  }
  const ranked = [...counts].sort(([, a], [, b]) => b.n - a.n || b.last - a.last).map(([t]) => t)
  if (ranked.length) return here && !ranked.includes(here) ? [...ranked, here] : ranked
  const newest = worked.edited.at(-1)
  if (newest && !(await isDir(dirname(newest))))
    throw new ChangesError(`${tildify(dirname(newest))} is gone: its worktree was removed?`)
  if (here) return [here]
  if (!(await isDir(cwd)))
    throw new ChangesError(`${tildify(cwd)} is gone: its worktree was removed?`)
  throw new ChangesError(`${tildify(cwd)} isn't in a git repository.`)
}

export type Status = 'A' | 'M' | 'D'

export type Changes = {
  // The repository's top folder.
  dir: string
  // The commit compared with, as a full id; HEAD's own when only what isn't committed counts.
  base: string
  // How it reads: "since main (1a2b3c4)", "uncommitted on main".
  since: string
  branch: string | null
  // What differs from base in the working tree, relative to dir: committed, staged, not yet
  // staged, and new files git doesn't ignore.
  files: { path: string; status: Status }[]
}

// The branch work leaves from, as refs to compare with: origin's default, and the local branch
// of the same name, else main, else master. Its short name too.
async function defaultBranch(
  run: Git,
  dir: string,
): Promise<{ name: string; refs: string[] } | null> {
  const has = async (ref: string) =>
    (await gitOr(run, dir, ['rev-parse', '--verify', '-q', ref])) !== null
  const remote = await gitOr(run, dir, [
    'symbolic-ref',
    '-q',
    '--short',
    'refs/remotes/origin/HEAD',
  ])
  if (remote) {
    const name = remote.replace(/^origin\//, '')
    return { name, refs: [remote, ...((await has(`refs/heads/${name}`)) ? [name] : [])] }
  }
  for (const name of ['main', 'master'])
    if (await has(`refs/heads/${name}`)) return { name, refs: [name] }
  return null
}

function parseNameStatus(out: string): Changes['files'] {
  const parts = out.split('\0')
  const files: Changes['files'] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const s = parts[i]!.charAt(0)
    const path = parts[i + 1]!
    if (!path) continue
    files.push({ path, status: s === 'A' ? 'A' : s === 'D' ? 'D' : 'M' })
  }
  return files
}

// What `dir`'s repository changed: on a branch of its own, since it left the default branch
// (the newest commit both share, so the default moving on doesn't show); on the default branch,
// or with no commits of its own, what isn't committed.
export async function findChanges(dir: string, run: Git = git): Promise<Changes> {
  const head = await gitOr(run, dir, ['rev-parse', '--verify', '-q', 'HEAD'])
  if (!head) throw new ChangesError(`${tildify(dir)} has no commits yet.`)
  const branch = await gitOr(run, dir, ['symbolic-ref', '-q', '--short', 'HEAD'])
  const def = await defaultBranch(run, dir)
  let base = head
  let since = def ? `uncommitted on ${branch ?? def.name}` : 'uncommitted'
  if (def && branch !== def.name) {
    // With both origin's and the local branch, the newer of the two places it left.
    const mb = await gitOr(run, dir, ['merge-base', 'HEAD', ...def.refs])
    if (mb && mb !== head) {
      base = mb
      since = `since ${def.name} (${mb.slice(0, 7)})`
    } else since = `uncommitted, nothing committed since ${def.name}`
  }
  const tracked = parseNameStatus(
    await run(dir, ['diff', '--name-status', '-z', '--no-renames', '--ignore-submodules', base]),
  )
  const untracked = (await run(dir, ['ls-files', '-z', '--others', '--exclude-standard']))
    .split('\0')
    .filter(Boolean)
    .map((path) => ({ path, status: 'A' as const }))
  return { dir, base, since, branch, files: [...tracked, ...untracked] }
}

// The first of the places it worked that has changes to show, else what the likeliest one has
// (nothing), to say so. A meta repo whose planning edits are committed gives way to the worktree.
export async function firstChanged(dirs: string[], run: Git = git): Promise<Changes> {
  let first: Changes | null = null
  for (const dir of dirs) {
    const c = await findChanges(dir, run).catch((e: unknown) => {
      if (dir === dirs[0]) throw e
      return null
    })
    if (c?.files.length) return c
    first ??= c
  }
  return first!
}

// The two sides as folders, for a diff tool that compares folders (nvim's :DiffTool): `left` holds
// each changed file as it was at base, `right` a link to each as it is now, so what is edited on
// the right is the working tree's own file. Made fresh under `root` each time.
export async function writeSides(
  c: Changes,
  root: string,
): Promise<{ left: string; right: string }> {
  const name = basename(c.dir)
  const left = join(root, `${name}@${c.base.slice(0, 7)}`)
  const right = join(root, name)
  await rm(root, { recursive: true, force: true })
  await mkdir(left, { recursive: true })
  await mkdir(right, { recursive: true })
  for (const f of c.files) {
    if (f.status !== 'A') {
      const blob = await gitBlob(c.dir, `${c.base}:${f.path}`).catch(() => null)
      if (blob) {
        await mkdir(dirname(join(left, f.path)), { recursive: true })
        await writeFile(join(left, f.path), blob)
      }
    }
    if (f.status !== 'D') {
      const now = join(c.dir, f.path)
      // A submodule or a folder would bring its whole tree along.
      if (await isDir(now)) continue
      await mkdir(dirname(join(right, f.path)), { recursive: true })
      await symlink(now, join(right, f.path))
    }
  }
  return { left, right }
}

// A file's bytes at a commit, as git has them.
const gitBlob = (dir: string, spec: string) =>
  new Promise<Buffer>((resolve, reject) => {
    execFile(
      'git',
      ['-C', dir, 'cat-file', 'blob', spec],
      { maxBuffer: 256 << 20, timeout: 20_000, encoding: 'buffer' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
  })

// ---------- the command nvim runs ----------

// What d runs in nvim, in the repository's folder, when config.toml doesn't say: nvim's own
// :DiffTool (0.12 and later, no plugin), comparing the folders writeSides makes. With
// diffview.nvim, `DiffviewOpen {base}` is the same view.
export const DIFF_DEFAULT = 'packadd nvim.difftool | DiffTool {left} {right}'

// A path or name as one argument of an Ex command: spaces and what Ex would read as something
// else get a backslash.
export const exArg = (s: string) => s.replace(/[\\ \t|"%#]/g, (c) => `\\${c}`)

export type DiffValues = {
  dir: string
  base: string
  // Only worked out when the command uses them.
  left?: string
  right?: string
  // Of the changed files, the ones the conversation edited itself, relative to dir.
  files: string[]
}

export const needsSides = (template: string) => /\{(left|right)\}/.test(template)

// The command with its placeholders filled in: {dir} {base} {left} {right} {files}. Anything
// else in braces is left as it is.
export function fillCommand(template: string, v: DiffValues): string {
  return template.replace(/\{(dir|base|left|right|files)\}/g, (whole, key: string) => {
    if (key === 'files') return v.files.map(exArg).join(' ')
    const value = v[key as 'dir' | 'base' | 'left' | 'right']
    return value === undefined ? whole : exArg(value)
  })
}

// Of what changed, the files the conversation edited, relative to the repository.
export function editedHere(c: Changes, edited: string[]): string[] {
  const changed = new Set(c.files.map((f) => f.path))
  return edited
    .filter((p) => isWithin(p, c.dir))
    .map((p) => p.slice(c.dir.length + 1))
    .filter((p) => changed.has(p))
}
