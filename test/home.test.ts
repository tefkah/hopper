import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  countOpen,
  extraDirs,
  initHome,
  loadProjects,
  parsePathsLocal,
  parseProjects,
} from '../src/home.ts'
import { hopperPrompt } from '../src/prompts.ts'

describe('parseProjects', () => {
  it('defaults path and open file from the key', () => {
    const [p] = parseProjects('[[project]]\nkey = "meta/inbox"\n', '/h')
    expect(p).toEqual({
      key: 'meta/inbox',
      path: '/h/projects/meta/inbox',
      // Projects in the home folder run from it, so they share its CLAUDE.md.
      runIn: '/h',
      openFile: '/h/projects/meta/inbox/_open.md',
    })
  })
  it('takes an explicit path and open file', () => {
    const [p] = parseProjects(
      '[[project]]\nkey = "bh/atlas"\npath = "/w/atlas"\nopen_file = "/w/bh-meta/planning/bh/atlas/_open.md"\n',
      '/h',
    )
    expect(p?.path).toBe('/w/atlas')
    expect(p?.openFile).toBe('/w/bh-meta/planning/bh/atlas/_open.md')
  })
  it('rejects bad and duplicate keys', () => {
    expect(() => parseProjects('[[project]]\nkey = "Meta Inbox"\n', '/h')).toThrow(
      /key must look like/,
    )
    expect(() =>
      parseProjects('[[project]]\nkey = "a/b"\n[[project]]\nkey = "a/b"\n', '/h'),
    ).toThrow(/twice/)
  })
})

describe('countOpen', () => {
  it('counts unchecked task lines only', () => {
    const md =
      '# x\n\n## Build\n- [ ] **One** — a\n- [x] done\n  - [ ] nested\nprose - [ ] not a task\n* [ ] star\n'
    expect(countOpen(md)).toBe(3)
  })
})

describe('initHome', () => {
  it('creates the skeleton once and never overwrites', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hopper-'))
    const first = await initHome(home)
    expect(first).toContain('projects.toml')
    expect(first).toContain('projects/meta/inbox/_open.md')
    expect((await loadProjects(home)).map((p) => p.key)).toEqual(['meta/inbox'])

    await writeFile(join(home, 'projects', 'meta', 'inbox', '_open.md'), 'mine\n')
    expect(await initHome(home)).toEqual([])
    expect(await readFile(join(home, 'projects', 'meta', 'inbox', '_open.md'), 'utf8')).toBe(
      'mine\n',
    )
  })
})

describe('sources', () => {
  // A meta repo with two checked-out projects (one reached through a symlink) and one that
  // isn't on this machine, and a Hopper home that imports it under "pm".
  const setup = async (source: string) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hopper-src-')))
    const meta = join(root, 'pm-meta')
    await mkdir(join(meta, 'planning', 'pinemoor', 'tern'), { recursive: true })
    await mkdir(join(root, 'tern'))
    await mkdir(join(root, 'lantern', 'ledger'), { recursive: true })
    await symlink(join(root, 'lantern'), join(root, 'ln-link'))
    await writeFile(
      join(meta, 'paths.local'),
      [
        '# paths.local',
        '',
        `pinemoor/tern=${root}/tern`,
        `lantern/apps/ledger=${root}/ln-link/ledger`,
        `pinemoor/gone=${root}/not-here`,
        'Bad Key=/x',
      ].join('\n'),
    )
    const home = join(root, 'home')
    await initHome(home)
    const toml = await readFile(join(home, 'projects.toml'), 'utf8')
    await writeFile(join(home, 'projects.toml'), toml + source.replaceAll('META', meta))
    return { root, meta, home }
  }

  it('reads paths.local, skipping comments and keys Hopper cannot use', () => {
    expect(parsePathsLocal('# c\n\na/b=~/x\nBad=/y\nnoequals\n')).toEqual([
      { key: 'a/b', path: join(process.env['HOME'] ?? '', 'x') },
    ])
  })

  it('lists what the registry has checked out here, under the prefix, with the meta repo', async () => {
    const { root, meta, home } = await setup('\n[[source]]\nprefix = "pm"\nrepo = "META"\n')
    const projects = await loadProjects(home)
    expect(projects.map((p) => p.key)).toEqual([
      'meta/inbox',
      'pm/meta',
      'pm/pinemoor/tern',
      'pm/lantern/apps/ledger',
    ])
    const hopper = projects.find((p) => p.key === 'pm/pinemoor/tern')
    expect(hopper).toEqual({
      key: 'pm/pinemoor/tern',
      path: join(root, 'tern'),
      runIn: meta,
      openFile: join(meta, 'planning', 'pinemoor', 'tern', '_open.md'),
      meta: { repo: meta, key: 'pinemoor/tern' },
    })
    // Symlinks resolve, since Claude reports the physical cwd.
    expect(projects.find((p) => p.key === 'pm/lantern/apps/ledger')?.path).toBe(
      join(root, 'lantern', 'ledger'),
    )
  })

  it('strips the leading segment, and lets a [[project]] add to an imported one', async () => {
    const { home } = await setup(
      '\n[[source]]\nprefix = "pm"\nrepo = "META"\nstrip = "pinemoor"\n\n[[project]]\nkey = "pm/tern"\nmodel = "opus"\n',
    )
    const projects = await loadProjects(home)
    expect(projects.map((p) => p.key)).toContain('pm/lantern/apps/ledger')
    const hopper = projects.find((p) => p.key === 'pm/tern')
    expect(hopper?.model).toBe('opus')
    expect(hopper?.meta?.key).toBe('pinemoor/tern')
    expect(projects.filter((p) => p.key === 'pm/tern')).toHaveLength(1)
  })

  it('skips a source not on this machine, and refuses a key from two places', async () => {
    const missing = await setup('\n[[source]]\nprefix = "bh"\nrepo = "/no/such/meta"\n')
    expect((await loadProjects(missing.home)).map((p) => p.key)).toEqual(['meta/inbox'])
    const twice = await setup(
      '\n[[source]]\nprefix = "pm"\nrepo = "META"\n[[source]]\nprefix = "pm"\nrepo = "META"\n',
    )
    await expect(loadProjects(twice.home)).rejects.toThrow(/two places/)
  })

  it('runs a registry project from the meta repo, through its symlink when there is one', async () => {
    const { root, meta, home } = await setup('\n[[source]]\nprefix = "pm"\nrepo = "META"\n')
    await mkdir(join(meta, 'projects', 'pinemoor'), { recursive: true })
    await symlink(join(root, 'tern'), join(meta, 'projects', 'pinemoor', 'tern'))
    const hopper = (await loadProjects(home)).find((p) => p.key === 'pm/pinemoor/tern')!
    expect(hopper.meta?.link).toBe(join(meta, 'projects', 'pinemoor', 'tern'))
    expect(hopperPrompt(hopper)).toContain(
      `code is in ${hopper.meta?.link} (a link to ${hopper.path})`,
    )
  })

  it('runs in each project with run_in = "project", adding the planning folder instead', async () => {
    const { meta, home } = await setup(
      '\n[[source]]\nprefix = "pm"\nrepo = "META"\nrun_in = "project"\n',
    )
    const hopper = (await loadProjects(home)).find((p) => p.key === 'pm/pinemoor/tern')!
    expect(hopper.runIn).toBe(hopper.path)
    expect(extraDirs(hopper)).toEqual([join(meta, 'planning', 'pinemoor', 'tern')])
  })

  it('gives a conversation what it needs outside the meta repo, and points it at the rules', async () => {
    const { meta, home } = await setup('\n[[source]]\nprefix = "pm"\nrepo = "META"\n')
    const projects = await loadProjects(home)
    const hopper = projects.find((p) => p.key === 'pm/pinemoor/tern')!
    // It runs from the meta repo; only its own folder, outside it, needs adding.
    expect(extraDirs(hopper)).toEqual([hopper.path])
    expect(hopperPrompt(hopper)).toContain(`${meta}/CLAUDE.md`)
    expect(hopperPrompt(hopper)).toContain(`code is in ${hopper.path}`)
    expect(hopperPrompt(hopper)).not.toContain('"## Open"')
    expect(hopperPrompt(hopper)).toContain('update the open file under those rules before you stop')
    // Pointed at the agents' guide, which a conversation in the home folder loads by itself.
    const guide = join(home, 'CLAUDE.md')
    expect(hopperPrompt(hopper, { guide })).toContain(`How Hopper works, for agents`)
    expect(hopperPrompt(hopper, { guide })).toContain(guide)
    const inbox = projects.find((p) => p.key === 'meta/inbox')!
    expect(hopperPrompt(inbox, { guide })).not.toContain(guide)
    expect(extraDirs(inbox)).toEqual([])
    expect(extraDirs(projects.find((p) => p.key === 'pm/meta')!)).toEqual([])
  })
})
