import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  findNvim,
  ghosttyArgs,
  inGhostty,
  openChanges,
  openNvim,
  remoteKeys,
  sh,
  type Ran,
  type Run,
} from '../src/nvim.ts'

// Records what would have run, answering from `answer`; nothing is started.
function fakeRun(answer: (cmd: string, args: string[]) => Partial<Ran> = () => ({})) {
  const calls: { cmd: string; args: string[] }[] = []
  const run: Run = async (cmd, args) => {
    calls.push({ cmd, args })
    return { code: 0, stdout: '', stderr: '', ...answer(cmd, args) }
  }
  return { run, calls }
}

const here = () => {
  const calls: { nvim: string; args: string[]; dir: string }[] = []
  return {
    calls,
    here: async (nvim: string, args: string[], dir: string) => void calls.push({ nvim, args, dir }),
  }
}

describe('openNvim', () => {
  const base = { dir: '/w/tern', command: 'DiffviewOpen abc', nvim: '/bin/nvim' }

  it('sends a running nvim a new tab in the folder, when its socket answers', async () => {
    const { run, calls } = fakeRun((_, args) =>
      args.includes('--remote-expr') ? { stdout: '1\n' } : {},
    )
    const h = here()
    const r = await openNvim({ ...base, server: '/tmp/n.sock', ghostty: true, run, here: h.here })
    expect(r).toEqual({ where: 'server' })
    expect(calls.map((c) => c.args)).toEqual([
      ['--server', '/tmp/n.sock', '--remote-expr', '1'],
      [
        '--server',
        '/tmp/n.sock',
        '--remote-send',
        '<C-\\><C-N>:tabnew<CR>:tcd /w/tern<CR>:DiffviewOpen abc<CR>',
      ],
    ])
    expect(h.calls).toEqual([])
  })

  it('opens a Ghostty window when no nvim answers, and says why', async () => {
    const { run, calls } = fakeRun((_, args) => (args.includes('--remote-expr') ? { code: 1 } : {}))
    const r = await openNvim({
      ...base,
      server: '/tmp/n.sock',
      ghostty: true,
      env: { PATH: '/opt/bin:/usr/bin' },
      run,
      here: here().here,
    })
    expect(r).toEqual({ where: 'ghostty', note: 'no nvim at /tmp/n.sock' })
    expect(calls[1]).toEqual({
      cmd: 'osascript',
      args: ghosttyArgs('/w/tern', '/bin/nvim', 'DiffviewOpen abc', '/opt/bin:/usr/bin'),
    })
    expect(calls[1]!.args.slice(2)).toEqual([
      '/w/tern',
      "'/bin/nvim' -c 'DiffviewOpen abc'",
      'PATH=/opt/bin:/usr/bin',
    ])
  })

  it('says nothing of the default socket when no nvim listens there', async () => {
    const { run } = fakeRun((_, args) => (args.includes('--remote-expr') ? { code: 1 } : {}))
    const r = await openNvim({
      ...base,
      server: '/tmp/n.sock',
      optional: true,
      ghostty: true,
      run,
      here: here().here,
    })
    expect(r).toEqual({ where: 'ghostty' })
  })

  it('runs nvim in place off Ghostty, or when Ghostty says no', async () => {
    const h = here()
    expect(await openNvim({ ...base, ghostty: false, run: fakeRun().run, here: h.here })).toEqual({
      where: 'here',
    })
    expect(h.calls).toEqual([
      { nvim: '/bin/nvim', args: ['-c', 'DiffviewOpen abc'], dir: '/w/tern' },
    ])
    const refused = fakeRun(() => ({ code: 1, stderr: 'Not authorized to send Apple events\n' }))
    const r = await openNvim({ ...base, ghostty: true, run: refused.run, here: here().here })
    expect(r.where).toBe('here')
    expect(r.note).toContain('Not authorized')
  })

  it('quotes for the shell and for nvim’s keys', () => {
    expect(sh("it's")).toBe(`'it'\\''s'`)
    expect(remoteKeys('/w/my tern', 'echo "<b>"')).toBe(
      '<C-\\><C-N>:tabnew<CR>:tcd /w/my\\ tern<CR>:echo "<lt>b>"<CR>',
    )
  })

  it('knows Ghostty by what it sets, on macOS only', () => {
    expect(inGhostty({ TERM_PROGRAM: 'ghostty' }, 'darwin')).toBe(true)
    expect(inGhostty({ TERM_PROGRAM: 'ghostty' }, 'linux')).toBe(false)
    expect(inGhostty({ TERM_PROGRAM: 'tmux' }, 'darwin')).toBe(false)
  })
})

describe('openChanges', () => {
  let root: string
  let repo: string
  let tree: string
  let bin: string
  const git = (dir: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      },
    ).trim()

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'hopper-nvim-')))
    repo = join(root, 'tern')
    await mkdir(repo)
    git(repo, 'init', '-q', '-b', 'main')
    await writeFile(join(repo, '.gitignore'), '.claude/\n')
    await writeFile(join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'first')
    tree = join(repo, '.claude', 'worktrees', 'fix')
    git(repo, 'worktree', 'add', '-q', '-b', 'worktree-fix', tree)
    await writeFile(join(tree, 'a.txt'), 'one\ntwo\n')
    // An nvim on the PATH that is never run.
    bin = join(root, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'nvim'), '#!/bin/sh\nexit 1\n')
    await chmod(join(bin, 'nvim'), 0o755)
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  const transcript = async (cwd: string) => {
    const path = join(root, 'session.jsonl')
    await writeFile(
      path,
      [
        { type: 'user', cwd: repo },
        {
          type: 'assistant',
          cwd,
          message: {
            content: [
              { type: 'tool_use', name: 'Edit', input: { file_path: join(tree, 'a.txt') } },
            ],
          },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    )
    return path
  }

  it('finds the worktree it moved into and opens its changes, the sides written', async () => {
    const { run, calls } = fakeRun()
    const said = await openChanges({
      transcript: await transcript(tree),
      cwd: repo,
      ghostty: true,
      sides: join(root, 'sides'),
      env: { PATH: bin },
      run,
      here: here().here,
    })
    expect(said).toMatch(
      /^1 file in .*tern\/\.claude\/worktrees\/fix \(worktree-fix\), uncommitted, nothing committed since main: a new Ghostty window\.$/,
    )
    expect(await findNvim({ PATH: bin })).toBe(join(bin, 'nvim'))
    const [osa] = calls
    expect(osa?.args[2]).toBe(tree)
    expect(osa?.args[3]).toBe(
      `'${join(bin, 'nvim')}' -c 'packadd nvim.difftool | DiffTool ${join(root, 'sides', `fix@${git(tree, 'rev-parse', 'HEAD').slice(0, 7)}`)} ${join(root, 'sides', 'fix')}'`,
    )
  })

  it('uses the command config.toml gives, and says when nothing changed', async () => {
    const { run, calls } = fakeRun()
    const h = here()
    await openChanges({
      transcript: null,
      cwd: tree,
      template: 'DiffviewOpen {base} -- {files}',
      ghostty: false,
      sides: join(root, 'sides'),
      env: { PATH: bin },
      run,
      here: h.here,
    })
    expect(calls).toEqual([])
    // Without a transcript nothing says what it edited, so {files} is empty.
    expect(h.calls[0]?.args).toEqual(['-c', `DiffviewOpen ${git(tree, 'rev-parse', 'HEAD')} -- `])
    expect(h.calls[0]?.dir).toBe(tree)
    const nothing = await openChanges({
      transcript: null,
      cwd: repo,
      ghostty: false,
      sides: join(root, 'sides'),
      env: { PATH: bin },
      run,
      here: h.here,
    })
    expect(nothing).toMatch(/^Nothing changed in .*tern \(main\), uncommitted on main\.$/)
    expect(h.calls).toHaveLength(1)
  })

  it('says so when its worktree is gone, and opens nothing', async () => {
    const { run, calls } = fakeRun()
    const said = await openChanges({
      transcript: null,
      cwd: join(repo, '.claude', 'worktrees', 'removed'),
      ghostty: true,
      sides: join(root, 'sides'),
      env: { PATH: bin },
      run,
      here: here().here,
    })
    expect(said).toMatch(/removed is gone/)
    expect(calls).toEqual([])
  })
})
