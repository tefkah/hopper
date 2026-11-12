import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { unattendedPermissions } from '../src/claude.ts'
import { draftNew, UsageError } from '../src/commands.ts'
import { OVERNIGHT_DEFAULTS, parseSettings, type Config } from '../src/config.ts'
import { recordConversation } from '../src/conversations.ts'
import { dispatch, inWindow, nightOf, readiness } from '../src/dispatch.ts'
import { listDrafts, parseDraft, serializeDraft, type Draft } from '../src/drafts.ts'
import { writeGuide } from '../src/guide.ts'
import type { Project } from '../src/home.ts'
import type { AccountState, Item } from '../src/model.ts'
import { hopperPrompt, unattendedPrompt } from '../src/prompts.ts'
import { listRuns, runRoutine, type Routine } from '../src/routines/index.ts'
import type { startDraft } from '../src/start.ts'

const bh = { name: 'bh', label: 'BH', configDir: null }

async function setup(overnight: Partial<Config['overnight']> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'hopper-dispatch-'))
  await writeFile(join(home, 'projects.toml'), '[[project]]\nkey = "meta/inbox"\n')
  const config: Config = {
    path: join(home, 'config.toml'),
    accountsPath: '',
    home,
    accounts: [bh],
    routes: [{ prefix: '', accounts: ['bh'] }],
    overnight: { ...OVERNIGHT_DEFAULTS, ...overnight },
  }
  const project: Project = {
    key: 'meta/inbox',
    path: join(home, 'projects', 'meta', 'inbox'),
    runIn: home,
    openFile: join(home, 'projects', 'meta', 'inbox', '_open.md'),
  }
  return { home, config, project }
}

const draft = (id: string, fields: Partial<Draft> = {}): Draft => ({
  id,
  project: 'meta/inbox',
  text: `Task ${id}\n`,
  created: 1,
  updated: 1,
  ...fields,
})

const signedIn = (week?: number): AccountState => ({
  account: bh,
  auth: { loggedIn: true },
  authError: null,
  usage:
    week === undefined
      ? null
      : { fiveHour: null, sevenDay: { pct: week, resetsAt: null }, fetchedAt: Date.now() },
  sessionError: null,
  sessions: [],
  sessionsAt: null,
  counts: { queue: 0, needs: 0, done: 0, live: 0 },
})

const convo = (id: string, where: Item['where'], state = 'done'): Item =>
  ({
    account: 'bh',
    id,
    sessionId: 's-' + id,
    kind: 'background',
    cwd: '/',
    name: id,
    startedAt: 0,
    state,
    where,
    key: 'meta/inbox',
  }) as Item

// A stand-in for startDraft that records what it was asked to start.
function fakeStart() {
  const started: string[] = []
  const start: typeof startDraft = async ({ draft: d, unattended }) => {
    expect(unattended).toBe(true)
    started.push(d.id)
    return { id: 'c-' + d.id, name: d.id }
  }
  return { started, start }
}

const noUsage = async () => null

describe('drafts carry their overnight fields', () => {
  it('round-trip', () => {
    const d = draft('a-1234', {
      queue: 'night',
      after: ['b-1', 'c-2'],
      done: 'the tests pass',
      proposed: 'groomer',
      depth: 2,
    })
    expect(parseDraft('a-1234', serializeDraft(d))).toEqual(d)
  })
})

describe('the night', () => {
  it('wraps midnight, and names a night by the day it began', () => {
    const at = (h: number, m = 0) => new Date(2026, 8, 28, h, m)
    expect(inWindow('22:00-07:00', at(23))).toBe(true)
    expect(inWindow('22:00-07:00', at(3))).toBe(true)
    expect(inWindow('22:00-07:00', at(7))).toBe(false)
    expect(inWindow('22:00-07:00', at(12))).toBe(false)
    expect(inWindow('01:00-05:00', at(2))).toBe(true)
    expect(nightOf('22:00-07:00', at(23))).toBe('2026-09-28')
    expect(nightOf('22:00-07:00', new Date(2026, 8, 29, 2))).toBe('2026-09-28')
  })
  it('is read from config.toml, numbers as numbers or strings', () => {
    const s = parseSettings(
      'home = "/h"\nnight = "23:00-06:00"\nnight_budget = "20"\nmax_running = 3\n',
      '/c.toml',
    )
    expect(s.overnight).toEqual({
      ...OVERNIGHT_DEFAULTS,
      window: '23:00-06:00',
      budget: 20,
      maxRunning: 3,
    })
    expect(() => parseSettings('home = "/h"\nnight = "late"\n', '/c.toml')).toThrow(/window/)
    expect(() => parseSettings('home = "/h"\nreserve = -1\n', '/c.toml')).toThrow(/whole number/)
  })
})

describe('readiness', () => {
  it('waits for what comes first to finish cleanly', async () => {
    const d = draft('b', { after: ['a'] })
    const meta = { 'c-a': { project: 'meta/inbox', startedAt: 0, draft: 'a' } }
    const at = (items: Item[], drafts: Draft[] = []) => readiness(d, { drafts, meta, items })
    expect(await at([], [draft('a')])).toEqual({ ready: false, reason: 'waits for a to start' })
    expect(await at([convo('c-a', 'queue', 'working')])).toMatchObject({ reason: /still running/ })
    expect(await at([convo('c-a', 'needs')])).toMatchObject({ reason: /needs you/ })
    expect(await at([convo('c-a', 'done')])).toEqual({ ready: true })
    // By its conversation id too.
    expect(
      await readiness(draft('x', { after: ['c-a'] }), {
        drafts: [],
        meta,
        items: [convo('c-a', 'done')],
      }),
    ).toEqual({ ready: true })
    expect(
      await readiness(draft('y', { after: ['zz'] }), { drafts: [], meta, items: [] }),
    ).toMatchObject({ reason: /doesn't know/ })
  })
  it('takes a clean result for a conversation that has been removed', async () => {
    const { home } = await setup()
    const result = join(home, 'r.md')
    await writeFile(result, 'needs: nothing\nAll done.\n')
    const meta = { 'c-a': { project: 'meta/inbox', startedAt: 0, draft: 'a', result } }
    const d = draft('b', { after: ['a'] })
    expect(await readiness(d, { drafts: [], meta, items: [] })).toEqual({ ready: true })
  })
})

describe('dispatch', () => {
  const night = new Date(2026, 8, 28, 23, 30)
  const day = new Date(2026, 8, 28, 14, 0)

  it('starts what is ready, oldest first, and says why the rest wait', async () => {
    const { config, project } = await setup()
    const { started, start } = fakeStart()
    const drafts = [
      draft('later', { queue: 'now', created: 5 }),
      draft('first', { queue: 'now', created: 2 }),
      draft('tonight', { queue: 'night' }),
      draft('after', { queue: 'now', after: ['first'] }),
      draft('plain'),
    ]
    const report = await dispatch({
      config,
      drafts,
      projects: [project],
      accounts: [signedIn(10)],
      items: [],
      now: day,
      deps: { start, usage: noUsage },
    })
    expect(started).toEqual(['first', 'later'])
    expect(report.waiting.map((w) => [w.draft, w.reason])).toEqual([
      ['tonight', 'starts in the night window (22:00-07:00)'],
      ['after', 'waits for first to start'],
    ])
  })

  it('keeps to max_running per account', async () => {
    const { config, project } = await setup({ maxRunning: 1 })
    const { started, start } = fakeStart()
    await recordConversation(config.home, 'busy', {
      project: 'meta/inbox',
      startedAt: 0,
      unattended: true,
    })
    const report = await dispatch({
      config,
      drafts: [draft('a', { queue: 'now' })],
      projects: [project],
      accounts: [signedIn(10)],
      items: [convo('busy', 'queue', 'working')],
      now: day,
      deps: { start, usage: noUsage },
    })
    expect(started).toEqual([])
    expect(report.waiting[0]?.reason).toBe('bh already runs 1')
  })

  it('stops at the night budget, measured from where the week stood when the night began', async () => {
    const { config, project } = await setup({ budget: 20 })
    const { started, start } = fakeStart()
    const run = (week: number, now: Date, id: string) =>
      dispatch({
        config,
        drafts: [draft(id, { queue: 'night' })],
        projects: [project],
        accounts: [signedIn(week)],
        items: [],
        now,
        deps: { start, usage: async () => signedIn(week).usage },
      })
    await run(40, night, 'a') // the night begins at 40%
    expect(JSON.parse(await readFile(join(config.home, 'state', 'night.json'), 'utf8'))).toEqual({
      night: '2026-09-28',
      start: { bh: 40 },
    })
    await run(55, new Date(2026, 8, 29, 1), 'b') // 15 points in: still room
    const late = await run(61, new Date(2026, 8, 29, 3), 'c') // 21 points: over
    expect(started).toEqual(['a', 'b'])
    expect(late.waiting[0]?.reason).toBe("bh spent tonight's budget (21 points)")
  })

  it('keeps the reserve, day or night', async () => {
    const { config, project } = await setup({ reserve: 10 })
    const { started, start } = fakeStart()
    const report = await dispatch({
      config,
      drafts: [draft('a', { queue: 'now' })],
      projects: [project],
      accounts: [signedIn(92)],
      items: [],
      now: day,
      deps: { start, usage: async () => signedIn(92).usage },
    })
    expect(started).toEqual([])
    expect(report.waiting[0]?.reason).toMatch(/reserve \(92%/)
  })
})

describe('hopper draft new', () => {
  it('makes a draft, and follow-ups inherit the project, the queue and one more link', async () => {
    const { config } = await setup({ chainDepth: 1 })
    const stdin = async () => ''
    const a = await draftNew(
      config,
      ['--project', 'meta/inbox', '--queue', 'night', 'First'],
      stdin,
    )
    expect(a.draft).toMatchObject({ project: 'meta/inbox', queue: 'night', text: 'First\n' })
    const b = await draftNew(config, ['--after', a.draft.id, '--done', 'it works', 'Next'], stdin)
    expect(b.draft).toMatchObject({
      queue: 'night',
      after: [a.draft.id],
      depth: 1,
      done: 'it works',
    })
    // Past chain_depth, a follow-up is proposed rather than queued.
    const c = await draftNew(config, ['--after', b.draft.id, 'And then'], stdin)
    expect(c.draft.queue).toBeUndefined()
    expect(c.draft.proposed).toMatch(/^chain after/)
    expect(c.note).toMatch(/past chain_depth 1/)
    expect((await listDrafts(config.home)).length).toBe(3)
  })
  it('takes an account, and a local one brings the local model', async () => {
    const { config: base } = await setup()
    const lo = {
      name: 'lo',
      label: 'lo',
      configDir: '/d/lo',
      provider: 'ollama' as const,
      local: { baseUrl: 'http://x', model: 'tern', context: 131072, concurrency: 1 },
    }
    const config = { ...base, accounts: [bh, lo] }
    const stdin = async () => ''
    const at = (...flags: string[]) =>
      draftNew(config, ['--project', 'meta/inbox', ...flags, 'Go'], stdin)
    expect((await at('--account', 'bh')).draft).toMatchObject({ account: 'bh' })
    expect((await at('--account', 'lo')).draft).toMatchObject({ account: 'lo', model: 'local' })
    await expect(at('--account', 'lo', '--model', 'opus')).rejects.toThrow(/is local/)
    await expect(at('--account', 'bh', '--model', 'local')).rejects.toThrow(/isn't local/)
    await expect(at('--account', 'zz')).rejects.toThrow(/one of bh, lo/)
  })
  it('proposals never queue, and bad input says what is wrong', async () => {
    const { config } = await setup()
    const stdin = async () => 'From stdin\n'
    const p = await draftNew(
      config,
      ['--project', 'meta/inbox', '--proposed', 'groomer', '--queue', 'now', '-'],
      stdin,
    )
    expect(p.draft).toMatchObject({ proposed: 'groomer', text: 'From stdin\n' })
    expect(p.draft.queue).toBeUndefined()
    await expect(draftNew(config, ['--project', 'nope/x', 'Hi'], stdin)).rejects.toThrow(
      /No project/,
    )
    await expect(
      draftNew(config, ['--project', 'meta/inbox', '--model', 'gpt', 'Hi'], stdin),
    ).rejects.toThrow(UsageError)
    await expect(draftNew(config, ['--after', 'missing', 'Hi'], stdin)).rejects.toThrow(
      /no draft or conversation/,
    )
  })
})

describe('unattended prompts', () => {
  it('say never to wait, where the result goes, and how to chain while there is depth', () => {
    const p = unattendedPrompt({ result: '/h/results/a.md', draft: 'a', depth: 0, chainDepth: 2 })
    expect(p).toMatch(/Never wait for an answer/)
    expect(p).toContain('/h/results/a.md')
    expect(p).toContain('hopper draft new --after a')
    expect(unattendedPrompt({ result: '/r', draft: 'a', depth: 2, chainDepth: 2 })).not.toContain(
      'hopper draft new',
    )
    const project: Project = { key: 'meta/inbox', path: '/h/p', runIn: '/h', openFile: '/h/o.md' }
    expect(hopperPrompt(project)).toMatch(/talking it through/)
    expect(hopperPrompt(project, { unattended: true })).not.toMatch(/talking it through/)
    expect(hopperPrompt(project)).toMatch(/remove it when it is done/)
    expect(hopperPrompt(project, { unattended: true })).not.toMatch(/before you stop/)
  })
})

describe('unattended permissions', () => {
  it('are auto, except for models without it, which get dontAsk and a narrow allow-list', () => {
    expect(unattendedPermissions('sonnet', ['/h/r'])).toEqual({ permissionMode: 'auto' })
    expect(unattendedPermissions(undefined, ['/h/r'])).toEqual({ permissionMode: 'auto' })
    const haiku = unattendedPermissions('haiku', ['/h/r'])
    expect(haiku.permissionMode).toBe('dontAsk')
    expect(haiku.allowedTools).toContain('Edit(//h/r/**)')
    expect(haiku.allowedTools).toContain('Bash(git log:*)')
    expect(haiku.allowedTools).not.toContain('Bash')
  })
  it('are dontAsk on a local account, whatever the model: auto mode is Claude judging', () => {
    const lo = {
      name: 'lo',
      label: 'lo',
      configDir: '/d/lo',
      provider: 'ollama' as const,
      local: { baseUrl: 'http://x', model: 'tern', context: 131072, concurrency: 1 },
    }
    expect(unattendedPermissions('tern', ['/h/r'], lo).permissionMode).toBe('dontAsk')
  })
})

describe('routine checks', () => {
  const routine = (check: string): Routine => ({
    name: 'nightly',
    project: 'meta/inbox',
    schedule: '',
    enabled: true,
    prompt: 'It failed; find out why.',
    check,
  })
  it('a check that passes starts no conversation', async () => {
    const { config, project } = await setup()
    await mkdir(project.runIn, { recursive: true })
    const out = await runRoutine({
      config,
      routine: routine('true'),
      projects: [project],
      accounts: [signedIn()],
      sessions: [],
      systemPrompt: () => '',
    })
    expect(out).toEqual({ status: 'passed' })
    const [run] = await listRuns(config.home, 'nightly')
    expect(run?.status).toBe('passed')
    // It leaves no report; the run log says it passed.
    expect(run?.result).toBeUndefined()
  })
  it('a check that fails starts one, with its output in the prompt', async () => {
    const { config, project } = await setup()
    const bin = join(config.home, 'claude')
    const log = join(config.home, 'args')
    await writeFile(
      bin,
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${log}\necho "backgrounded · abc123 · x"\n`,
      { mode: 0o755 },
    )
    process.env['HOPPER_CLAUDE'] = bin
    try {
      const out = await runRoutine({
        config,
        routine: routine('echo broken thing; exit 3'),
        projects: [project],
        accounts: [signedIn()],
        sessions: [],
        systemPrompt: () => '',
      })
      expect(out).toMatchObject({ status: 'started', id: 'abc123' })
      const args = await readFile(log, 'utf8')
      expect(args).toContain('failed (exit 3)')
      expect(args).toContain('broken thing')
      expect(args).toContain('--permission-mode\nauto')
    } finally {
      delete process.env['HOPPER_CLAUDE']
    }
  })
})

describe('the guide', () => {
  it('is written to the home folder once, and again only when it changes', async () => {
    const { home } = await setup()
    expect(await writeGuide(home)).toBe(true)
    expect(await readFile(join(home, 'CLAUDE.md'), 'utf8')).toMatch(/^# Hopper, for agents/)
    expect(await writeGuide(home)).toBe(false)
  })
})
