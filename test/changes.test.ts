import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ChangesError,
  editedHere,
  exArg,
  fillCommand,
  findChanges,
  firstChanged,
  needsSides,
  readWorked,
  workedIn,
  writeSides,
} from '../src/changes.ts'

const sh = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim()

// A repository on main with two commits, and a worktree on a branch of its own the way Claude
// Code makes one, under .claude/worktrees/.
let root: string
let repo: string
let tree: string
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'hopper-changes-')))
  repo = join(root, 'tern')
  await mkdir(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await writeFile(join(repo, 'gone.txt'), 'bye\n')
  await writeFile(join(repo, '.gitignore'), '.claude/\n')
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-q', '-m', 'first')
  tree = join(repo, '.claude', 'worktrees', 'fix')
  sh(repo, 'worktree', 'add', '-q', '-b', 'worktree-fix', tree)
  // main moves on after the branch left; that isn't the conversation's.
  await writeFile(join(repo, 'later.txt'), 'main moved\n')
  sh(repo, 'add', 'later.txt')
  sh(repo, 'commit', '-q', '-m', 'main moves on')
  // The conversation: a commit on its branch, then edits it hasn't committed.
  await writeFile(join(tree, 'a.txt'), 'one\ntwo\n')
  sh(tree, 'commit', '-q', '-am', 'two')
  await rm(join(tree, 'gone.txt'))
  await writeFile(join(tree, 'new file.txt'), 'new\n')
})
afterAll(() => rm(root, { recursive: true, force: true }))

describe('findChanges', () => {
  it('compares a branch with where it left main, committed or not, new files included', async () => {
    const c = await findChanges(tree)
    expect(c.dir).toBe(tree)
    expect(c.branch).toBe('worktree-fix')
    expect(c.base).toBe(sh(repo, 'rev-parse', 'main~1'))
    expect(c.since).toMatch(/^since main \([0-9a-f]{7}\)$/)
    expect(c.files).toEqual([
      { path: 'a.txt', status: 'M' },
      { path: 'gone.txt', status: 'D' },
      { path: 'new file.txt', status: 'A' },
    ])
  })
  it('on main itself, shows only what is not committed', async () => {
    await writeFile(join(repo, 'a.txt'), 'edited in place\n')
    try {
      const c = await findChanges(repo)
      expect(c.base).toBe(sh(repo, 'rev-parse', 'HEAD'))
      expect(c.since).toBe('uncommitted on main')
      expect(c.files).toEqual([{ path: 'a.txt', status: 'M' }])
    } finally {
      sh(repo, 'checkout', '-q', '--', 'a.txt')
    }
    expect((await findChanges(repo)).files).toEqual([])
  })
  it('prefers origin’s default branch when there is one', async () => {
    // A remote whose HEAD is main: origin/main is a commit behind the local main.
    sh(repo, 'update-ref', 'refs/remotes/origin/main', 'main~1')
    sh(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    try {
      const c = await findChanges(tree)
      // The newest place it shares with either, so local commits on main don't show.
      expect(c.base).toBe(sh(repo, 'rev-parse', 'main~1'))
      expect(c.since.startsWith('since main')).toBe(true)
    } finally {
      sh(repo, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
      sh(repo, 'update-ref', '-d', 'refs/remotes/origin/main')
    }
  })
})

describe('workedIn', () => {
  it('is the repository of its newest folder, a subfolder or not', async () => {
    await mkdir(join(tree, 'src'), { recursive: true })
    expect(await workedIn({ cwd: join(tree, 'src'), edited: [] }, repo)).toEqual([tree])
    // No folder in the transcript: the one Claude reports.
    expect(await workedIn({ cwd: null, edited: [] }, tree)).toEqual([tree])
  })
  it('goes where most of its edits are, over a folder it went back to', async () => {
    const edited = [join(tree, 'a.txt'), join(tree, 'new file.txt'), join(repo, 'later.txt')]
    expect(await workedIn({ cwd: repo, edited }, repo)).toEqual([tree, repo])
  })
  it('shows the first place with changes: committed planning edits give way to the worktree', async () => {
    const edited = [join(repo, 'later.txt'), join(repo, 'a.txt')]
    const places = await workedIn({ cwd: tree, edited }, tree)
    expect(places).toEqual([repo, tree])
    expect((await firstChanged(places)).dir).toBe(tree)
    // Nowhere with changes: the likeliest, to say nothing changed there.
    expect((await firstChanged([repo])).files).toEqual([])
  })
  it('says when the folder is gone, or is not in git', async () => {
    const gone = join(repo, '.claude', 'worktrees', 'removed')
    await expect(workedIn({ cwd: gone, edited: [] }, repo)).rejects.toThrow(/is gone/)
    // Edits in a removed worktree don't fall back to the checkout around it.
    await expect(
      workedIn({ cwd: repo, edited: [join(gone, 'x.ts')] }, repo),
    ).rejects.toBeInstanceOf(ChangesError)
    const plain = await mkdtemp(join(tmpdir(), 'hopper-plain-'))
    await expect(workedIn({ cwd: plain, edited: [] }, plain)).rejects.toThrow(/isn't in a git/)
    await rm(plain, { recursive: true })
  })
})

describe('writeSides', () => {
  it('writes the files as they were, and links them as they are now', async () => {
    const c = await findChanges(tree)
    const { left, right } = await writeSides(c, join(root, 'sides'))
    expect(await readFile(join(left, 'a.txt'), 'utf8')).toBe('one\n')
    expect(await readFile(join(left, 'gone.txt'), 'utf8')).toBe('bye\n')
    await expect(readFile(join(left, 'new file.txt'))).rejects.toThrow()
    expect(await readlink(join(right, 'a.txt'))).toBe(join(tree, 'a.txt'))
    expect(await readlink(join(right, 'new file.txt'))).toBe(join(tree, 'new file.txt'))
    await expect(readlink(join(right, 'gone.txt'))).rejects.toThrow()
    // Made fresh each time.
    await writeSides({ ...c, files: [] }, join(root, 'sides'))
    await expect(readFile(join(left, 'a.txt'))).rejects.toThrow()
  })
})

describe('the command', () => {
  it('fills in its placeholders, each one argument to Ex', () => {
    const v = { dir: '/w/my tern', base: 'abc123', left: '/t/l', right: '/t/r', files: ['a b.ts'] }
    expect(fillCommand('DiffviewOpen {base} -- {files}', v)).toBe('DiffviewOpen abc123 -- a\\ b.ts')
    expect(fillCommand('packadd nvim.difftool | DiffTool {left} {right}', v)).toBe(
      'packadd nvim.difftool | DiffTool /t/l /t/r',
    )
    expect(fillCommand('e {dir} {other}', v)).toBe('e /w/my\\ tern {other}')
    expect(exArg('a|b%c')).toBe('a\\|b\\%c')
    expect(needsSides('DiffviewOpen {base}')).toBe(false)
    expect(needsSides('DiffTool {left} {right}')).toBe(true)
  })
  it('narrows to the changed files the conversation edited, within the repository', async () => {
    const c = await findChanges(tree)
    const edited = [join(tree, 'a.txt'), join(tree, 'unchanged.txt'), join(repo, 'a.txt')]
    expect(editedHere(c, edited)).toEqual(['a.txt'])
  })
})

describe('readWorked', () => {
  it('finds the newest folder and the files edited, leaving out a subagent’s', async () => {
    const line = (o: object) => JSON.stringify(o)
    const use = (name: string, file: string) => ({
      type: 'assistant',
      cwd: '/w/tern/.claude/worktrees/fix',
      message: { content: [{ type: 'tool_use', name, input: { file_path: file } }] },
    })
    const path = join(root, 'session.jsonl')
    await writeFile(
      path,
      [
        line({ type: 'user', cwd: '/w/tern' }),
        line(use('Write', '/w/tern/.claude/worktrees/fix/b.ts')),
        line(use('Edit', '/w/tern/.claude/worktrees/fix/a.ts')),
        line(use('Edit', '/w/tern/.claude/worktrees/fix/b.ts')),
        line({ ...use('Edit', '/w/elsewhere/c.ts'), isSidechain: true, cwd: '/w/elsewhere' }),
        line(use('Read', '/w/tern/README.md')),
        'not json {"cwd":',
      ].join('\n'),
    )
    expect(await readWorked(path)).toEqual({
      cwd: '/w/tern/.claude/worktrees/fix',
      edited: ['/w/tern/.claude/worktrees/fix/a.ts', '/w/tern/.claude/worktrees/fix/b.ts'],
    })
    expect(await readWorked(join(root, 'missing.jsonl'))).toEqual({ cwd: null, edited: [] })
  })
})
