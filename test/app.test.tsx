import { execFile } from 'node:child_process'
import { appendFile, mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { render } from 'ink-testing-library'
import { beforeAll, describe, expect, it } from 'vitest'

import { loadAwake, saveAwake } from '../src/awake.ts'
import type { Session } from '../src/claude.ts'
import { addAccount, OVERNIGHT_DEFAULTS, setPrefixes, type Config } from '../src/config.ts'
import { loadDone } from '../src/done.ts'
import { loadHeld } from '../src/held.ts'
import { initHome, loadProjects } from '../src/home.ts'
import { draftSession, toItems, type Snapshot } from '../src/model.ts'
import { App, byGroup } from '../src/tui/App.tsx'
import { fakeClaude } from './helpers.ts'

let config: Config = {
  path: '/c/config.toml',
  accountsPath: '/c/accounts.toml',
  home: '/h',
  accounts: [],
  routes: [],
  overnight: OVERNIGHT_DEFAULTS,
}
config = addAccount(config, { name: 'bh', label: 'Blue Heron', configDir: null })
config = addAccount(config, { name: 'pm', label: 'Pinemoor', configDir: '/tmp/hopper-test-pm' })
config = setPrefixes(setPrefixes(config, 'bh', ['bh/']), 'pm', ['pm/', 'meta/'])
const projects = [
  {
    key: 'meta/inbox',
    path: '/h/projects/meta/inbox',
    runIn: '/h/projects/meta/inbox',
    openFile: '',
  },
  {
    key: 'meta/ideas',
    path: '/h/projects/meta/ideas',
    runIn: '/h/projects/meta/ideas',
    openFile: '',
  },
]
const now = Date.now()
const session = (over: Partial<Session>): Session => ({
  account: 'bh',
  id: 'abc12345',
  sessionId: 's-' + over.name,
  kind: 'background',
  cwd: '/elsewhere',
  name: 'x',
  startedAt: now - 60_000,
  state: 'working',
  ...over,
})
const snapshot: Snapshot = {
  at: now,
  drafts: [],
  routines: [],
  runs: [],
  reports: {},
  projects,
  projectsError: null,
  openCounts: new Map([
    ['meta/inbox', 3],
    ['meta/ideas', 0],
  ]),
  accounts: [
    {
      account: config.accounts[0]!,
      auth: { loggedIn: true, email: 'me@blueheron.example', subscriptionType: 'team' },
      authError: null,
      usage: {
        fiveHour: { pct: 22, resetsAt: null },
        sevenDay: { pct: 41, resetsAt: null },
        fetchedAt: now - 3_600_000,
      },
      sessionError: null,
      sessions: [],
      sessionsAt: null,
      counts: { queue: 1, needs: 1, done: 0, live: 0 },
    },
    {
      account: config.accounts[1]!,
      auth: { loggedIn: false },
      authError: null,
      usage: null,
      sessionError: null,
      sessions: [],
      sessionsAt: null,
      counts: { queue: 0, needs: 0, done: 0, live: 0 },
    },
  ],
  items: toItems(
    [
      session({ name: 'Sort the inbox', cwd: '/h/projects/meta/inbox', state: 'working' }),
      session({ name: 'Draft the spring newsletter', cwd: '/w/bh-meta', state: 'blocked' }),
    ],
    projects,
  ),
}

const tick = () => new Promise((r) => setTimeout(r, 30))
// Waits for something slower than a render (a child process), up to two seconds.
const until = async (ok: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 20))
}
const press = async (stdin: { write: (s: string) => void }, keys: string) => {
  stdin.write(keys)
  await tick()
}
// After esc a draft is saved and selected on the list, its text on the right.
const onList = (frame: () => string | undefined) =>
  until(() => (frame() ?? '').includes('⏎ TO KEEP WRITING')) // the heading is upper case
// The panel with the keyboard, as the app last said (onFocus): the screen shows it only in colour.
let focused = ''
const onFocus = (panel: string) => void (focused = panel)
const focusOf = () => focused

describe('the list order', () => {
  it('puts routines soonest to run first, then the ones with no next run, each by name', () => {
    const r = (name: string, nextAt?: number) =>
      ({ kind: 'routine', name, startedAt: 0, ...(nextAt ? { nextAt } : {}) }) as never
    const got = [r('paused-b'), r('late', 300), r('paused-a'), r('b-soon', 100), r('a-soon', 100)]
      .sort(byGroup)
      .map((i: { name: string }) => i.name)
    expect(got).toEqual(['a-soon', 'b-soon', 'late', 'paused-a', 'paused-b'])
  })
})

describe('App', () => {
  it('opens on Conversations and shows both accounts, the queue and what needs you', async () => {
    const { lastFrame, unmount } = render(
      <App onFocus={onFocus} config={config} load={async () => snapshot} />,
    )
    await tick()
    const f = lastFrame() ?? ''
    expect(focusOf()).toBe('conversations')
    expect(f).toContain('p find a project')
    expect(f).toContain('41%')
    expect(f).toContain('pm  not signed in')
    expect(f).toContain('Sort t')
    expect(f).toContain('WAITING ON YOU 1')
    unmount()
  })

  it('titles the tab with how many conversations need you', async () => {
    const titles: string[] = []
    const { unmount } = render(
      <App
        onFocus={onFocus}
        config={config}
        load={async () => snapshot}
        setTitle={(t) => titles.push(t)}
      />,
    )
    await until(() => titles.at(-1) === 'Hopper (1)')
    expect(titles.at(0)).toBe('Hopper')
    expect(titles.at(-1)).toBe('Hopper (1)')
    unmount()
  })

  it('lists only the projects with something going on, by full key', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={config} load={async () => snapshot} />,
    )
    await tick()
    expect(lastFrame()).toContain('meta/inbox')
    expect(lastFrame()).not.toMatch(/\bideas\b/)
    await press(stdin, 'p')
    await press(stdin, '\r') // ⏎ on it narrows the list to it
    expect(lastFrame()).toMatch(/\(c\) ─+ meta\/inbox/)
    unmount()
  })

  it('x quits only when pressed twice', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={config} load={async () => snapshot} />,
    )
    await tick()
    await press(stdin, 'x')
    expect(lastFrame()).toContain('Press x again to quit.')
    await press(stdin, 'j') // anything else lets it go
    expect(lastFrame()).not.toContain('Press x again to quit.')
    unmount()
  })

  // A stand-in for caffeinate: how many holds there are right now.
  const fakeAwake = () => {
    const held = { now: 0, ever: 0 }
    const keepAwake = () => {
      held.now++
      held.ever++
      return () => void held.now--
    }
    return { held, keepAwake }
  }
  const barOf = (frame: string | undefined) => (frame ?? '').trimEnd().split('\n').at(-1) ?? ''
  // The mark, last on the line: the same column on every screen.
  const AWAKE_LAST = /awake$/

  it('z holds the Mac awake, with awake at the end of the key bar, until z again; it is kept', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hopper-app-'))
    const { held, keepAwake } = fakeAwake()
    const { lastFrame, stdin, unmount } = render(
      <App
        onFocus={onFocus}
        config={{ ...config, home }}
        load={async () => snapshot}
        keepAwake={keepAwake}
      />,
    )
    await tick()
    expect(barOf(lastFrame())).not.toMatch(AWAKE_LAST)
    await press(stdin, 'z')
    expect(held.now).toBe(1)
    expect(lastFrame()).toContain('Keeping this Mac awake')
    expect(barOf(lastFrame()).trimEnd()).toMatch(AWAKE_LAST)
    await press(stdin, 'j') // the message goes; the mark stays, after ? all keys
    expect(barOf(lastFrame()).trimEnd()).toMatch(/all keys {2}awake$/)
    await until(async () => (await loadAwake(home)) === true)
    expect(await loadAwake(home)).toBe(true)
    await press(stdin, ',') // on every screen
    expect(barOf(lastFrame()).trimEnd()).toMatch(AWAKE_LAST)
    await press(stdin, '\u001b')
    await press(stdin, 'z')
    expect(held.now).toBe(0)
    expect(lastFrame()).toContain('This Mac can sleep again.')
    expect(barOf(lastFrame())).not.toMatch(AWAKE_LAST)
    await until(async () => (await loadAwake(home)) === false)
    expect(await loadAwake(home)).toBe(false)
    unmount()
  })

  it('comes back holding the Mac awake when it was left on, and lets go when it closes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hopper-app-'))
    await saveAwake(home, true)
    const { held, keepAwake } = fakeAwake()
    const { lastFrame, unmount } = render(
      <App
        onFocus={onFocus}
        config={{ ...config, home }}
        load={async () => snapshot}
        keepAwake={keepAwake}
      />,
    )
    await until(() => held.now === 1)
    expect(held.now).toBe(1)
    await tick()
    expect(barOf(lastFrame()).trimEnd()).toMatch(AWAKE_LAST)
    unmount()
    expect(held.now).toBe(0)
  })

  it('without a way to keep awake, z does nothing and nothing shows', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hopper-app-'))
    await saveAwake(home, true)
    const { lastFrame, stdin, unmount } = render(
      <App
        onFocus={onFocus}
        config={{ ...config, home }}
        load={async () => snapshot}
        keepAwake={null}
      />,
    )
    await tick()
    await press(stdin, 'z')
    expect(barOf(lastFrame()).trimEnd()).not.toMatch(/awake$/)
    expect(lastFrame()).not.toContain('Keeping this Mac awake')
    unmount()
  })

  it('p finds as you type and ⏎ focuses it; esc comes back to the list, then shows every project', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={config} load={async () => snapshot} />,
    )
    await tick()
    await press(stdin, 'p')
    expect(focusOf()).toBe('projects')
    expect(lastFrame()).toContain(' find ')
    await press(stdin, 'ide')
    expect(lastFrame()).toContain(' find   ide')
    expect(lastFrame()).toContain(' 1 found ─╮')
    await press(stdin, '\r')
    expect(focusOf()).toBe('conversations')
    expect(lastFrame()).toMatch(/\(c\) ─+ meta\/ideas/)
    expect(lastFrame()).toContain('Nothing going on.')
    // Back in Projects nothing is typed, and esc leaves the list as it was.
    await press(stdin, 'p')
    expect(lastFrame()).not.toContain('found ─╮')
    await press(stdin, '\u001b')
    expect(focusOf()).toBe('conversations')
    expect(lastFrame()).toMatch(/\(c\) ─+ meta\/ideas/)
    await press(stdin, '\u001b')
    expect(focusOf()).toBe('conversations')
    expect(lastFrame()).toMatch(/\(c\) ─+ all projects/)
    expect(lastFrame()).toContain('Sort t')
    // It never goes up to Projects.
    await press(stdin, '\u001b')
    expect(focusOf()).toBe('conversations')
    unmount()
  })

  it('a folder found narrows the list to every project in it, and tab there says to pick one', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={config} load={async () => snapshot} />,
    )
    await tick()
    await press(stdin, 'p')
    await press(stdin, 'meta')
    await press(stdin, '\t')
    expect(lastFrame()).toContain('meta is a folder. Pick a project in it.')
    await press(stdin, '\r')
    expect(lastFrame()).toMatch(/\(c\) ─+ meta ─/)
    unmount()
  })

  it('a click selects a project, and a second click on it focuses it, as ⏎ would', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={config} load={async () => snapshot} />,
    )
    await tick()
    // The list has the keyboard, so the first click is only a select. Mouse lines count from 1;
    // so do the frame's.
    const y = (lastFrame() ?? '').split('\n').findIndex((l) => /meta\/inbox +\d/.test(l)) + 1
    const click = `\u001b[<0;40;${y}M`
    await press(stdin, `\u001b[<35;40;${y}M`) // moving over it changes nothing
    expect(focusOf()).toBe('conversations')
    await press(stdin, click)
    expect(focusOf()).toBe('projects')
    expect(lastFrame()).toMatch(/\(c\) ─+ all projects/)
    await press(stdin, click)
    expect(lastFrame()).toMatch(/\(c\) ─+ meta\/inbox/)
    unmount()
  })

  it('a click selects an account', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={config} load={async () => snapshot} />,
    )
    await tick()
    const y = (lastFrame() ?? '').split('\n').findIndex((l) => l.includes('pm  not signed in'))
    await press(stdin, `\u001b[<0;5;${y + 1}M`)
    expect(focusOf()).toBe('accounts')
    expect(lastFrame()).toContain('│▌pm  not signed in')
    expect(lastFrame()).toContain('pm · Pinemoor')
    unmount()
  })

  it('the wheel moves the selection in the list under the pointer, and a click focuses it', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={config} load={async () => snapshot} />,
    )
    await tick()
    // The list is under the band of accounts and projects, across the first 68 columns.
    await press(stdin, '\u001b[<0;40;12M')
    expect(focusOf()).toBe('conversations')
    await press(stdin, '\u001b[<65;40;12M')
    // Down one: from the waiting session to the running one, shown in SELECTED.
    expect(lastFrame()).toContain('Sort t')
    unmount()
  })

  it('moving over a row leaves the selection alone; a click selects it', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={config} load={async () => snapshot} />,
    )
    await tick()
    // The list's frame starts on line 9: a heading, the running session on line 11, a gap, a
    // heading, then the waiting one.
    await press(stdin, 'v')
    await press(stdin, '\u001b[<35;20;11M')
    expect(focusOf()).toBe('done')
    await press(stdin, '\u001b[<0;20;11M')
    expect(focusOf()).toBe('conversations')
    expect(lastFrame()).toMatch(/│ Sort the inbox  +│/)
    // A click on a heading only gives the list the keyboard.
    await press(stdin, '\u001b[<0;20;10M')
    expect(lastFrame()).toMatch(/│ Sort the inbox  +│/)
    unmount()
  })

  it('a second click on the selected row opens it, as ⏎ would', async () => {
    const d = {
      id: 'd1',
      project: 'meta/inbox',
      text: 'a waiting draft',
      created: now,
      updated: now,
    }
    const item = {
      ...draftSession(d, projects, 'bh'),
      where: 'needs' as const,
      key: 'meta/inbox',
      activeAt: now,
    }
    const snap = { ...snapshot, drafts: [d], items: [item] }
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={config} load={async () => snap} />,
    )
    await tick()
    await press(stdin, 'v') // from Done, so the first click only gives the list the keyboard
    await press(stdin, '\u001b[<0;20;11M')
    expect(focusOf()).toBe('conversations')
    expect(lastFrame()).not.toContain('NEW CONVERSATION')
    await press(stdin, '\u001b[<0;20;11M')
    expect(lastFrame()).toContain('NEW CONVERSATION')
    unmount()
  })

  it('← on the list stays on the list; Projects is p', async () => {
    const { stdin, unmount } = render(
      <App onFocus={onFocus} config={config} load={async () => snapshot} />,
    )
    await tick()
    await press(stdin, '\u001b[D')
    expect(focusOf()).toBe('conversations')
    await press(stdin, 'v')
    await press(stdin, '\u001b[D')
    expect(focusOf()).toBe('done')
    unmount()
  })

  it('→ on the list does what ⏎ does: opens what is selected', async () => {
    const d = {
      id: 'd1',
      project: 'meta/inbox',
      text: 'a waiting draft',
      created: now,
      updated: now,
    }
    const item = {
      ...draftSession(d, projects, 'bh'),
      where: 'needs' as const,
      key: 'meta/inbox',
      activeAt: now,
    }
    const snap = { ...snapshot, drafts: [d], items: [item] }
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={config} load={async () => snap} />,
    )
    await tick()
    await press(stdin, '\u001b[C') // → opens the draft, as ⏎ would
    expect(lastFrame()).toContain(' draft ')
    expect(lastFrame()).toContain('a waiting draft')
    unmount()
  })

  it('a click on the details of something not open opens it, as ⏎ would', async () => {
    const d = {
      id: 'd1',
      project: 'meta/inbox',
      text: 'a waiting draft',
      created: now,
      updated: now,
    }
    const item = {
      ...draftSession(d, projects, 'bh'),
      where: 'needs' as const,
      key: 'meta/inbox',
      activeAt: now,
    }
    const snap = { ...snapshot, drafts: [d], items: [item] }
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={config} load={async () => snap} />,
    )
    await tick()
    // The list has the keyboard; the draft's details are on the right.
    expect(lastFrame()).not.toContain('NEW CONVERSATION')
    // At 100 columns the right panel starts at column 69.
    await press(stdin, '\u001b[<0;80;6M')
    expect(lastFrame()).toContain('NEW CONVERSATION')
    expect(lastFrame()).toContain('a waiting draft')
    unmount()
  })

  it('tab in Projects starts a conversation in the one found, and esc then comes back to the list', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={config} load={async () => snapshot} />,
    )
    await tick()
    await press(stdin, 'p')
    await press(stdin, 'ide')
    await press(stdin, '\t')
    expect(lastFrame()).toContain('NEW CONVERSATION')
    expect(lastFrame()).toContain('meta/ideas')
    // The list wasn't narrowed to it.
    expect(lastFrame()).toContain('all proje')
    await press(stdin, '\u001b')
    expect(lastFrame()).not.toContain('NEW CONVERSATION')
    expect(focusOf()).toBe('conversations')
    unmount()
  })

  it('v goes to Done, below the one list', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={config} load={async () => snapshot} />,
    )
    await tick()
    await press(stdin, 'v')
    expect(focusOf()).toBe('done')
    expect(lastFrame()).toContain('Nothing done.')
    unmount()
  })

  it('edits an account from the accounts panel and saves it', async () => {
    const saved: Config[] = []
    const { lastFrame, stdin, unmount } = render(
      <App
        onFocus={onFocus}
        config={config}
        load={async () => snapshot}
        save={async (c) => void saved.push(c)}
      />,
    )
    await tick()
    await press(stdin, 'a')
    expect(lastFrame()).toContain('bh/ as choice 1')
    await press(stdin, 'e')
    expect(lastFrame()).toContain('prefixes it runs')
    await press(stdin, ', meta')
    await press(stdin, '\r')
    expect(saved.at(-1)?.routes).toEqual([
      { prefix: 'bh/', accounts: ['bh'] },
      { prefix: 'meta/', accounts: ['pm', 'bh'] },
      { prefix: 'pm/', accounts: ['pm'] },
    ])
    await press(stdin, '1')
    expect(saved.at(-1)?.routes[1]).toEqual({ prefix: 'meta/', accounts: ['bh', 'pm'] })
    await press(stdin, 'j')
    await press(stdin, 'd')
    expect(lastFrame()).toContain('Remove pm from Hopper?')
    await press(stdin, 'd')
    expect(saved.at(-1)?.accounts.map((a) => a.name)).toEqual(['bh'])
    unmount()
  })

  it('refuses a bad prefix without saving, and says why', async () => {
    const saved: Config[] = []
    const { lastFrame, stdin, unmount } = render(
      <App
        onFocus={onFocus}
        config={config}
        load={async () => snapshot}
        save={async (c) => void saved.push(c)}
      />,
    )
    await tick()
    await press(stdin, 'a')
    await press(stdin, 'e')
    await press(stdin, ' Not A Prefix')
    await press(stdin, '\r')
    expect(saved).toHaveLength(0)
    expect(lastFrame()).toContain('is not a prefix')
    unmount()
  })
})

describe('conversations', () => {
  // One stand-in claude for the whole file: macOS scans a new executable the first time it
  // runs, which can take seconds. Its behaviour and log come from each call's environment.
  let bin = ''
  beforeAll(async () => {
    bin = await fakeClaude(
      'echo "$PWD|$*" >> "$HOPPER_FAKE_LOG"\n' +
        'case "$1" in --bg) if [ -n "$HOPPER_FAKE_UNTRUSTED" ]; then echo "Workspace not trusted."; exit 1; fi; echo "backgrounded · abc12345 · name";;\n' +
        '  attach) printf "fake claude screen\\n❯ "; while read -r line; do case "$line" in leave) printf "  enter to return · space to reply\\n";; box) printf "the prompt box\\n──────────\\n❯ \\n──────────\\033[1A\\r\\033[2C";; "") printf "\\033[2J\\033[Hback in the conversation\\n❯ ";; *) printf "you said: %s\\n❯ " "$line";; esac; done;; esac\n' +
        'exit 0',
    )
    await new Promise<void>((resolve) =>
      execFile(bin, ['warm-up'], { env: { ...process.env, HOPPER_FAKE_LOG: '/dev/null' } }, () =>
        resolve(),
      ),
    )
  })
  const setup = async (opts: { untrusted?: boolean } = {}) => {
    const home = await mkdtemp(join(tmpdir(), 'hopper-app-'))
    await initHome(home)
    await appendFile(join(home, 'projects.toml'), '\n[[project]]\nkey = "bh/atlas"\n')
    const log = join(home, 'calls.log')
    process.env['HOPPER_CLAUDE'] = bin
    process.env['HOPPER_FAKE_LOG'] = log
    if (opts.untrusted) process.env['HOPPER_FAKE_UNTRUSTED'] = '1'
    else delete process.env['HOPPER_FAKE_UNTRUSTED']
    const projects = await loadProjects(home)
    const cfg: Config = { ...setPrefixes(config, 'bh', ['bh/', 'meta/']), home }
    const snap: Snapshot = { ...snapshot, projects, items: [] }
    // The signed-in accounts above, with the drafts as they are on disk: esc leaves a draft on
    // the list, and the list's keys act on it there. A conversation the fake has started shows
    // as running, as it would in claude agents.
    const live = async (): Promise<Snapshot> => {
      const { listDrafts } = await import('../src/drafts.ts')
      const drafts = await listDrafts(home)
      const started = (await readFile(log, 'utf8').catch(() => '')).includes('--bg')
      const items = toItems(
        [
          ...drafts.map((d) => draftSession(d, projects, 'bh')),
          ...(started ? [session({ name: 'started', cwd: projects[0]!.runIn })] : []),
        ],
        projects,
      )
      for (const it of items) {
        const d = drafts.find((x) => `draft:${x.id}` === it.sessionId)
        if (d) Object.assign(it, { key: d.project, model: d.model, effort: d.effort })
      }
      return { ...snap, drafts, items }
    }
    return { home, cfg, snap, projects, log, live }
  }
  const calls = async (log: string) =>
    (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
  const done = () => {
    delete process.env['HOPPER_CLAUDE']
    delete process.env['HOPPER_FAKE_UNTRUSTED']
  }

  it('tab opens a draft where enter is a new line; esc leaves it on the list, s starts it', async () => {
    const { cfg, projects, log, live } = await setup()
    const { lastFrame, stdin, unmount } = render(<App onFocus={onFocus} config={cfg} load={live} />)
    await tick()
    await press(stdin, '\t')
    expect(lastFrame()).toContain('NEW CONVERSATION')
    expect(lastFrame()).toContain(' draft  meta/inbox')
    await press(stdin, 'backups for the home folder')
    await press(stdin, '\r')
    await press(stdin, 'nightly, somewhere off this machine')
    expect(await calls(log)).toEqual([]) // nothing starts while writing
    await press(stdin, '\u001b')
    await onList(lastFrame)
    expect(lastFrame()).toContain('s  start it')
    expect(lastFrame()).toContain('nightly, somewhere')
    await press(stdin, 's')
    // Starting doesn't open it or take the keyboard: it shows as running, and ⏎ opens it.
    await until(() => (lastFrame() ?? '').includes('Started on'))
    expect(await readFile(log, 'utf8')).not.toContain('|attach')
    expect(lastFrame()).not.toContain('fake claude screen')
    await press(stdin, '\r')
    await until(() => (lastFrame() ?? '').includes('fake claude screen'))
    const inbox = projects.find((p) => p.key === 'meta/inbox')!
    const logged = await readFile(log, 'utf8')
    // It runs from the home folder, not the project's own; the fake logs the physical cwd.
    expect(logged).toContain(
      `${await realpath(inbox.runIn)}|--bg --name meta/inbox · backups for the home folder`,
    )
    // The first message goes to Claude as written, new lines and all.
    expect(logged).toContain('backups for the home folder\nnightly, somewhere off this machine')
    expect(logged).toContain('|attach abc12345')
    // Picking no model or effort still tells Claude which, so the login doesn't decide.
    expect(logged).toContain('--model opus[1m] --effort high')
    // The conversation is inside Hopper, and typing goes to it.
    expect(lastFrame()).toContain('CONVERSATION')
    expect(lastFrame()).toContain(' claude ')
    await press(stdin, 'thanks')
    await press(stdin, '\r')
    await until(() => (lastFrame() ?? '').includes('you said: thanks'))
    expect(lastFrame()).toContain('you said: thanks')
    // ctrl+\ is Hopper's, not Claude's: it opens what the conversation changed (this one runs
    // in the home folder, which isn't in git, so it says so) and the keyboard stays here. With
    // the kitty keyboard protocol it comes as ctrl and a backslash.
    // Claude never sees it: what's typed after arrives clean.
    for (const [n, ctrlBackslash] of ['\u001c', '\u001b[92;5u'].entries()) {
      await press(stdin, ctrlBackslash)
      await until(() => (lastFrame() ?? '').includes("isn't in a git"))
      expect(lastFrame()).toContain("isn't in a git")
      expect(focusOf()).toBe('session')
      await press(stdin, `still here ${n}`)
      await press(stdin, '\r')
      await until(() => (lastFrame() ?? '').includes(`you said: still here ${n}`))
      expect(lastFrame()).toContain(`you said: still here ${n}`)
    }
    // ctrl+] comes back to Hopper and leaves the conversation live in the panel; ⏎ goes back in.
    await press(stdin, '\u001d')
    expect(focusOf()).toBe('conversations')
    expect(lastFrame()).toContain('you said: thanks')
    // On its row, d does the same, and so does ctrl+\.
    for (const diff of ['d', '\u001c']) {
      await press(stdin, 'j')
      expect(lastFrame()).not.toContain("isn't in a git")
      await press(stdin, diff)
      await until(() => (lastFrame() ?? '').includes("isn't in a git"))
      expect(lastFrame()).toContain("isn't in a git")
    }
    await press(stdin, '\r')
    expect(lastFrame()).toContain(' claude ')
    // Dragging across the conversation selects inside it and copies on release. At 100 columns
    // the right panel's cells start at column 70, row 2, under the panel's top edge.
    const clip = join(tmpdir(), `hopper-clip-${Date.now()}`)
    process.env['HOPPER_CLIPBOARD_FILE'] = clip
    await press(stdin, '\u001b[<0;70;2M') // press on "fake claude screen"
    await press(stdin, '\u001b[<32;73;2M') // drag four cells right
    await press(stdin, '\u001b[<0;73;2m') // let go
    expect(await readFile(clip, 'utf8')).toBe('fake')
    expect(lastFrame()).toContain('Copied 4 characters')
    delete process.env['HOPPER_CLIPBOARD_FILE']
    // Claude's own leave (its agents screen) comes back to Hopper too: Hopper presses enter to
    // return attach to the conversation, and it stays live in the panel.
    await press(stdin, 'leave')
    await press(stdin, '\r')
    await until(() => (lastFrame() ?? '').includes('back in the conversation'))
    expect(focusOf()).toBe('conversations')
    expect(lastFrame()).toContain('back in the conversation')
    // → goes back in.
    await press(stdin, '\u001b[C')
    expect(lastFrame()).toContain(' claude ')
    // At Claude's empty prompt (a one-line box, nothing typed), ← steps back at once and the
    // key never reaches Claude: what's typed next arrives clean.
    await press(stdin, 'box')
    await press(stdin, '\r')
    await until(() => (lastFrame() ?? '').includes('the prompt box'))
    await new Promise((r) => setTimeout(r, 200))
    await press(stdin, '\u001b[D')
    expect(focusOf()).toBe('conversations')
    await press(stdin, '\u001b[C')
    await press(stdin, 'clean')
    await press(stdin, '\r')
    await until(() => (lastFrame() ?? '').includes('you said: clean'))
    expect(lastFrame()).toContain('you said: clean')
    // esc is Claude's: it stays in the conversation.
    await press(stdin, '\u001b')
    expect(lastFrame()).toContain(' claude ')
    done()
    unmount()
  }, 15_000)

  it('a proposed draft has its own group, and u queues it: when there is room, tonight, off', async () => {
    const { home, cfg } = await setup()
    const { listDrafts, saveDraft } = await import('../src/drafts.ts')
    await saveDraft(home, {
      id: 'mul0-abcd',
      project: 'meta/inbox',
      text: 'tidy the README\n',
      created: 1,
      updated: 1,
      proposed: 'groomer',
      done: 'the README matches the commands',
    })
    const { lastFrame, stdin, unmount } = render(<App onFocus={onFocus} config={cfg} />)
    await tick()
    await press(stdin, 'c')
    await until(() => (lastFrame() ?? '').includes('PROPOSED 1'))
    expect(lastFrame()).toContain('proposed · u queues it')
    expect(lastFrame()).toContain('groomer')
    await press(stdin, 'u')
    await until(async () => (await listDrafts(home))[0]?.queue === 'now')
    const [queued] = await listDrafts(home)
    expect(queued).toMatchObject({ queue: 'now', done: 'the README matches the commands' })
    expect(queued?.proposed).toBeUndefined()
    await until(() => (lastFrame() ?? '').includes('up next: tonight'))
    expect(lastFrame()).toContain('UP NEXT 1')
    await press(stdin, 'u')
    await until(async () => (await listDrafts(home))[0]?.queue === 'night')
    // The next press acts on the list as refreshed.
    await until(() => (lastFrame() ?? '').includes('up next: off'))
    expect(lastFrame()).toContain('queued for tonight')
    await press(stdin, 'u')
    await until(async () => !(await listDrafts(home))[0]?.queue)
    expect((await listDrafts(home))[0]?.queue).toBeUndefined()
    done()
    unmount()
  }, 15_000)

  it('esc keeps a draft on the list; only enter goes back to writing; d throws it away', async () => {
    const { home, cfg } = await setup()
    const { lastFrame, stdin, unmount } = render(<App onFocus={onFocus} config={cfg} />) // the real loader: drafts come from disk
    await tick()
    await press(stdin, '\t')
    await press(stdin, 'maybe a weekly digest')
    await press(stdin, '\u001b')
    await onList(lastFrame)
    expect(lastFrame()).toContain('DRAFTS 1')
    expect(lastFrame()).not.toContain('NEW CONVERSATION')
    const { listDrafts } = await import('../src/drafts.ts')
    expect((await listDrafts(home)).map((d) => d.text)).toEqual(['maybe a weekly digest'])
    await press(stdin, 'q') // not a key of the draft's: it doesn't reopen it
    expect(lastFrame()).not.toContain('NEW CONVERSATION')
    await press(stdin, '\r')
    expect(lastFrame()).toContain('NEW CONVERSATION')
    await press(stdin, ' of what agents did')
    await press(stdin, '\u001b')
    await until(async () =>
      (await listDrafts(home)).some((d) => d.text.endsWith('of what agents did')),
    )
    await onList(lastFrame)
    await press(stdin, 'd') // not a draft's key any more
    expect(lastFrame()).not.toContain('Throw away the draft')
    await press(stdin, 'e')
    expect(lastFrame()).toContain('Throw away the draft')
    await press(stdin, 'e')
    await until(async () => (await listDrafts(home)).length === 0)
    expect(await listDrafts(home)).toEqual([])
    done()
    unmount()
  })

  it('the draft is a real text box: arrows move the cursor, shift selects, typing replaces', async () => {
    const { cfg, snap } = await setup()
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={cfg} load={async () => snap} />,
    )
    await tick()
    await press(stdin, '\t')
    await press(stdin, 'hello world')
    for (let i = 0; i < 5; i++) await press(stdin, '\u001b[D') // ← five times: before "world"
    await press(stdin, 'big ')
    expect(lastFrame()).toContain('hello big world')
    await press(stdin, '\u001b[F') // end
    for (let i = 0; i < 5; i++) await press(stdin, '\u001b[1;2D') // shift+← five times: "world"
    await press(stdin, 'there')
    expect(lastFrame()).toContain('hello big there')
    await press(stdin, '\u001bb') // option+← (as Mac terminals send it): back a word
    await press(stdin, 'out ')
    expect(lastFrame()).toContain('hello big out there')
    await press(stdin, '\u001b\u007f') // option+backspace (option as meta): a word
    expect(lastFrame()).toContain('hello big there')
    await press(stdin, '\u0017') // ctrl+w: a word, whatever the terminal's option setting
    expect(lastFrame()).toContain('hello there')
    done()
    unmount()
  })

  it('m and E choose the model and effort, and they go to Claude and are recorded', async () => {
    const { home, cfg, log, live } = await setup()
    const { lastFrame, stdin, unmount } = render(<App onFocus={onFocus} config={cfg} load={live} />)
    await tick()
    await press(stdin, '\t')
    await press(stdin, 'sort the inbox')
    await press(stdin, '\u001b')
    await onList(lastFrame)
    await press(stdin, 'm') // haiku
    await until(() => (lastFrame() ?? '').includes('model: haiku'))
    await press(stdin, 'E') // low
    await until(() => (lastFrame() ?? '').includes('effort: low'))
    expect(lastFrame()).toContain('haiku · low')
    await press(stdin, 's')
    await until(() => (lastFrame() ?? '').includes('Started on'))
    const logged = await readFile(log, 'utf8')
    expect(logged).toContain('--model haiku --effort low')
    expect(logged).not.toContain('|attach')
    const { loadConversations } = await import('../src/conversations.ts')
    expect((await loadConversations(home))['abc12345']).toMatchObject({
      model: 'haiku',
      effort: 'low',
    })
    done()
    unmount()
  })

  it('r turns a draft into a routine and saves it', async () => {
    const { home, cfg, live } = await setup()
    const { lastFrame, stdin, unmount } = render(<App onFocus={onFocus} config={cfg} load={live} />)
    await tick()
    await press(stdin, '\t')
    await press(stdin, 'triage the inbox')
    await press(stdin, '\u001b')
    await onList(lastFrame)
    expect(lastFrame()).toContain('r  make it a routine')
    await press(stdin, 'r')
    expect(lastFrame()).toContain('name this routine')
    expect(lastFrame()).toContain('triage-the-inbox')
    await press(stdin, '\r') // keep the suggested name
    expect(lastFrame()).toContain('when it runs')
    await press(stdin, '\r') // keep weekdays 9:00
    const { loadRoutine } = await import('../src/routines/index.ts')
    await until(async () => !!(await loadRoutine(home, 'triage-the-inbox')))
    expect(await loadRoutine(home, 'triage-the-inbox')).toMatchObject({
      project: 'meta/inbox',
      schedule: 'weekdays 9:00',
      prompt: 'triage the inbox',
      enabled: true,
    })
    const { listDrafts } = await import('../src/drafts.ts')
    expect(await listDrafts(home)).toEqual([]) // no longer a draft
    done()
    unmount()
  })

  it('a routine sits in the routines group; s on its row runs it now, as its own conversation', async () => {
    const { home, cfg, snap, projects, log } = await setup()
    const { saveRoutine } = await import('../src/routines/index.ts')
    const routine = {
      name: 'triage',
      project: 'meta/inbox',
      schedule: '',
      enabled: true,
      prompt: 'Sort the inbox.',
      model: 'haiku',
    }
    await saveRoutine(home, routine)
    const inbox = projects.find((p) => p.key === 'meta/inbox')!
    const withRoutine: Snapshot = {
      ...snap,
      routines: [routine],
      items: toItems(
        [
          {
            account: 'bh',
            id: null,
            sessionId: 'routine:triage',
            kind: 'routine',
            cwd: inbox.path,
            name: 'triage',
            startedAt: 0,
            state: 'manual',
          },
        ],
        projects,
      ),
    }
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={cfg} load={async () => withRoutine} />,
    )
    await tick()
    await press(stdin, 'c')
    expect(lastFrame()).toContain('ROUTINES')
    expect(lastFrame()).toContain('s  run now')
    await press(stdin, 's')
    // Like a started draft, the run shows in the list rather than opening.
    await until(() => (lastFrame() ?? '').includes('Running triage'))
    const logged = await readFile(log, 'utf8')
    expect(logged).not.toContain('|attach')
    expect(logged).toContain('--bg --name ↻ triage')
    expect(logged).toContain('--model haiku')
    const { listRuns } = await import('../src/routines/index.ts')
    expect((await listRuns(home, 'triage'))[0]).toMatchObject({ status: 'started', id: 'abc12345' })
    done()
    unmount()
  })

  it('⏎ on a routine goes into its prompt and reports, on the newest unread; ⏎ reads one, c opens its conversation', async () => {
    const { home, cfg, snap, projects, log } = await setup()
    const { saveRoutine, listReports } = await import('../src/routines/index.ts')
    const routine = {
      name: 'triage',
      project: 'meta/inbox',
      schedule: '',
      enabled: true,
      prompt: 'Sort.',
    }
    await saveRoutine(home, routine)
    const dir = join(home, 'routines', 'triage', 'runs')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '2026-09-27-0700.md'), 'needs: nothing\nQuiet day.\n')
    const body = ['needs: you', 'Two replies to check.', '', '# Replies', 'Line one of the detail.']
    await writeFile(join(dir, '2026-09-28-0700.md'), body.join('\n') + '\n')
    const run = {
      routine: 'triage',
      at: 0,
      status: 'started' as const,
      id: 'abc12345',
      account: 'bh',
      result: join(dir, '2026-09-28-0700.md'),
      prompt: 'x',
    }
    const inbox = projects.find((p) => p.key === 'meta/inbox')!
    const withReports: Snapshot = {
      ...snap,
      routines: [routine],
      runs: [run],
      // The older report is unread.
      reports: {
        triage: (await listReports(home, 'triage', [run])).map((r, i) => ({
          ...r,
          unread: i === 1,
        })),
      },
      items: toItems(
        [
          {
            account: 'bh',
            id: null,
            sessionId: 'routine:triage',
            kind: 'routine',
            cwd: inbox.path,
            name: 'triage',
            startedAt: 0,
            state: 'manual',
          },
          session({ name: 'triage run', id: 'abc12345', cwd: inbox.path, state: 'done' }),
        ],
        projects,
        new Set(['s-triage run']),
      ).map((i) => (i.kind === 'routine' ? { ...i, unread: 1 } : i)),
    }
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={cfg} load={async () => withReports} />,
    )
    await tick()
    await press(stdin, 'c')
    // The routine's row carries a dot for its unread report.
    expect(lastFrame()).toMatch(/● triage/)
    // The panel is narrow here, so the routine's keys leave room only to say there are reports.
    expect(lastFrame()).toContain('2 reports · ⏎ to read them')
    expect(lastFrame()).toContain('REPORTS · 1 UNREAD')
    expect(lastFrame()).toContain('edit the prompt')
    expect(lastFrame()).not.toContain('needs you')
    // ⏎ gives the list the keyboard, on the newest unread report.
    await press(stdin, '\r')
    expect(lastFrame()).toContain('⏎ → read it')
    const f = lastFrame() ?? ''
    // Each row is its time, in full, then its summary; newest first, the selected one lit.
    expect(f).toContain('Mon 28 Sept, 07:00')
    expect(f.indexOf('Two')).toBeGreaterThan(0)
    expect(f.indexOf('Two')).toBeLessThan(f.indexOf('Quie'))
    expect(f).toMatch(/▌● Sun 27 Sept, 07:00 {2}Quie/)
    // ↑ goes to the newer one, and again to the prompt's line.
    await press(stdin, '\u001b[A')
    expect(lastFrame()).toMatch(/▌ {2}Mon 28 Sept, 07:00 {2}Two/)
    await press(stdin, '\u001b[A')
    expect(lastFrame()).toContain('⏎ → edit the prompt')
    // ⏎ there edits it; closing the editor comes back to the list.
    await press(stdin, '\r')
    await until(() => (lastFrame() ?? '').includes('ROUTINE triage'))
    await press(stdin, '\u001b')
    await until(() => (lastFrame() ?? '').includes('⏎ → edit the prompt'))
    // ↓ back to the newest; ⏎ reads the one selected.
    await press(stdin, '\u001b[B')
    await press(stdin, '\r')
    await until(() => (lastFrame() ?? '').includes('REPORT '))
    expect(lastFrame()).toContain('Line one of the detail.')
    expect(lastFrame()).toContain('1 of 2')
    // J goes to the older one, K back.
    await press(stdin, 'J')
    await until(() => (lastFrame() ?? '').includes('2 of 2'))
    await press(stdin, 'K')
    await until(() => (lastFrame() ?? '').includes('1 of 2'))
    // esc goes up a level at a time: to the reports, then to the list.
    await press(stdin, '\u001b')
    expect(lastFrame()).not.toContain('Line one of the detail.')
    expect(lastFrame()).toContain('⏎ → read it')
    await press(stdin, '\u001b')
    expect(lastFrame()).toContain('⏎  open it')
    // c from the reports opens the conversation that wrote the selected one.
    await press(stdin, '\r')
    await press(stdin, '\u001b[A')
    await press(stdin, 'c')
    await until(() => (lastFrame() ?? '').includes('fake claude screen'))
    expect(await readFile(log, 'utf8')).toContain('attach')
    done()
    unmount()
  })

  // A stand-in $VISUAL: it keeps what it was given, then writes HOPPER_EDITOR_WRITE in its place,
  // or quits with an error, as vim's :cq does.
  const fakeEditor = async (home: string) => {
    const { chmod, writeFile } = await import('node:fs/promises')
    const bin = join(home, 'editor')
    const seen = join(home, 'seen.md')
    const script = [
      '#!/bin/sh',
      'cp "$1" "$HOPPER_EDITOR_SEEN"',
      '[ -n "$HOPPER_EDITOR_FAIL" ] && exit 1',
      '[ -n "$HOPPER_EDITOR_RM" ] && rm "$HOPPER_EDITOR_RM"',
      'printf "%s\\n" "$HOPPER_EDITOR_WRITE" > "$1"',
    ]
    await writeFile(bin, script.join('\n') + '\n')
    await chmod(bin, 0o755)
    process.env['VISUAL'] = bin
    process.env['HOPPER_EDITOR_SEEN'] = seen
    delete process.env['HOPPER_EDITOR_FAIL']
    const write = (text: string) => void (process.env['HOPPER_EDITOR_WRITE'] = text)
    const fail = (on = true) =>
      void (on
        ? (process.env['HOPPER_EDITOR_FAIL'] = '1')
        : delete process.env['HOPPER_EDITOR_FAIL'])
    // A file that goes while the editor is open.
    const gone = (path: string) => void (process.env['HOPPER_EDITOR_RM'] = path)
    const restore = () => {
      for (const k of ['SEEN', 'WRITE', 'FAIL', 'RM']) delete process.env[`HOPPER_EDITOR_${k}`]
      delete process.env['VISUAL']
    }
    return { seen: () => readFile(seen, 'utf8'), write, fail, gone, restore }
  }

  it('o writes a draft in $EDITOR: only its text goes there, and the rest of it stays', async () => {
    const { home, cfg, live } = await setup()
    const ed = await fakeEditor(home)
    const { listDrafts, saveDraft } = await import('../src/drafts.ts')
    await saveDraft(home, {
      id: 'd-1',
      project: 'meta/inbox',
      text: 'first thoughts',
      created: now,
      updated: now,
      model: 'sonnet',
      queue: 'night',
    })
    const { lastFrame, stdin, unmount } = render(<App onFocus={onFocus} config={cfg} load={live} />)
    await until(() => (lastFrame() ?? '').includes('first thoughts'))
    expect(lastFrame()).toContain('o  write it in $EDITOR')
    ed.write('second thoughts\nand a line more')
    await press(stdin, 'o')
    await until(
      async () => (await listDrafts(home))[0]?.text === 'second thoughts\nand a line more',
    )
    expect(await ed.seen()).toBe('first thoughts\n')
    expect((await listDrafts(home))[0]).toMatchObject({
      id: 'd-1',
      project: 'meta/inbox',
      model: 'sonnet',
      queue: 'night',
      created: now,
    })
    await until(() => (lastFrame() ?? '').includes('Draft saved.'))
    expect(lastFrame()).toContain('Draft saved.')
    // Quitting the editor with an error (vim's :cq) changes nothing.
    ed.fail()
    ed.write('lost')
    await press(stdin, 'o')
    await until(() => (lastFrame() ?? '').includes('quit with an error'))
    expect(lastFrame()).toContain('quit with an error')
    expect((await listDrafts(home))[0]?.text).toBe('second thoughts\nand a line more')
    // Started while it was being written (a queued one can be): what was written is a new draft.
    ed.fail(false)
    ed.gone(join(home, 'drafts', 'd-1.md'))
    ed.write('kept anyway')
    await press(stdin, 'o')
    await until(async () => (await listDrafts(home))[0]?.text === 'kept anyway')
    const [kept, ...rest] = await listDrafts(home)
    expect(rest).toEqual([])
    expect(kept?.id).not.toBe('d-1')
    expect(kept).toMatchObject({ project: 'meta/inbox', model: 'sonnet' })
    expect(kept?.queue).toBeUndefined()
    ed.restore()
    done()
    unmount()
  })

  it('o on a routine’s prompt line writes the prompt in $EDITOR, keeping the rest', async () => {
    const { home, cfg, snap, projects } = await setup()
    const ed = await fakeEditor(home)
    const { saveRoutine, loadRoutine } = await import('../src/routines/index.ts')
    const routine = {
      name: 'triage',
      project: 'meta/inbox',
      schedule: 'weekdays 9:00',
      enabled: true,
      prompt: 'Sort.',
      model: 'haiku',
    }
    await saveRoutine(home, routine)
    const inbox = projects.find((p) => p.key === 'meta/inbox')!
    const withRoutine: Snapshot = {
      ...snap,
      routines: [routine],
      items: toItems(
        [
          {
            account: 'bh',
            id: null,
            sessionId: 'routine:triage',
            kind: 'routine',
            cwd: inbox.path,
            name: 'triage',
            startedAt: 0,
            state: 'manual',
          },
        ],
        projects,
      ),
    }
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={cfg} load={async () => withRoutine} />,
    )
    await tick()
    await press(stdin, 'c')
    await press(stdin, '\r') // no reports: on the prompt's line
    expect(lastFrame()).toContain('o edit it in $EDITOR')
    ed.write('Sort, then file.')
    await press(stdin, 'o')
    await until(async () => (await loadRoutine(home, 'triage'))?.prompt === 'Sort, then file.')
    expect(await ed.seen()).toBe('Sort.\n')
    expect(await loadRoutine(home, 'triage')).toEqual({ ...routine, prompt: 'Sort, then file.' })
    await until(() => (lastFrame() ?? '').includes("Saved triage's prompt."))
    expect(lastFrame()).toContain("Saved triage's prompt.")
    // ctrl+g there does the same.
    ed.write('Sort, file, stop.')
    await press(stdin, '\u0007')
    await until(async () => (await loadRoutine(home, 'triage'))?.prompt === 'Sort, file, stop.')
    expect((await loadRoutine(home, 'triage'))?.prompt).toBe('Sort, file, stop.')
    ed.restore()
    done()
    unmount()
  })

  it('ctrl+g while writing carries on in $EDITOR and comes back with it; on the row it is o', async () => {
    const { home, cfg, live, log } = await setup()
    const ed = await fakeEditor(home)
    const { listDrafts } = await import('../src/drafts.ts')
    const { lastFrame, stdin, unmount } = render(<App onFocus={onFocus} config={cfg} load={live} />)
    await tick()
    await press(stdin, '\t')
    expect(lastFrame()).toContain('ctrl+g carry on in $EDITOR')
    await press(stdin, 'half a thought')
    ed.write('a whole thought\nand then some')
    await press(stdin, '\u0007')
    await until(() => (lastFrame() ?? '').includes('and then some'))
    // What was typed so far was saved before the editor had it, and went to it.
    expect(await ed.seen()).toBe('half a thought\n')
    // Back in Hopper's editor with the new text, the cursor at its end.
    expect(lastFrame()).toContain('NEW CONVERSATION')
    await press(stdin, ', more')
    expect(lastFrame()).toContain('and then some, more')
    await press(stdin, '\u001b')
    await onList(lastFrame)
    expect((await listDrafts(home))[0]?.text).toBe('a whole thought\nand then some, more')
    // On the draft's row, ctrl+g is o, and never g (dispatch).
    ed.write('rewritten')
    await press(stdin, '\u0007')
    await until(async () => (await listDrafts(home))[0]?.text === 'rewritten')
    expect((await listDrafts(home))[0]?.text).toBe('rewritten')
    expect(lastFrame()).not.toContain('Dispatching')
    // In a conversation ctrl+g is Claude's own: it goes to Claude, and no editor opens.
    await press(stdin, 's')
    await until(() => (lastFrame() ?? '').includes('Started on'))
    await press(stdin, '\r')
    await until(() => (lastFrame() ?? '').includes('fake claude screen'))
    const { rm } = await import('node:fs/promises')
    await rm(join(home, 'seen.md'))
    await press(stdin, '\u0007')
    await new Promise((r) => setTimeout(r, 200))
    expect(focusOf()).toBe('session')
    expect(await readFile(join(home, 'seen.md'), 'utf8').catch(() => null)).toBeNull()
    expect(await readFile(log, 'utf8')).toContain('|attach')
    ed.restore()
    done()
    unmount()
  })

  it('with draft_editor external, tab and ⏎ on a draft write it in $EDITOR', async () => {
    const { home, cfg, live } = await setup()
    const ed = await fakeEditor(home)
    const { listDrafts } = await import('../src/drafts.ts')
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={{ ...cfg, draftEditor: 'external' }} load={live} />,
    )
    await tick()
    // Nothing written: nothing kept.
    ed.write('')
    await press(stdin, '\t')
    await until(() => (lastFrame() ?? '').includes('Empty, so not kept.'))
    expect(await listDrafts(home)).toEqual([])
    ed.write('from my own editor')
    await press(stdin, '\t')
    await until(async () => (await listDrafts(home)).length === 1)
    expect(await ed.seen()).toBe('')
    expect(lastFrame()).not.toContain('NEW CONVERSATION')
    expect((await listDrafts(home))[0]).toMatchObject({
      project: 'meta/inbox',
      text: 'from my own editor',
    })
    await onList(lastFrame)
    ed.write('from my own editor, again')
    await press(stdin, '\r')
    await until(async () => (await listDrafts(home))[0]?.text === 'from my own editor, again')
    expect(await ed.seen()).toBe('from my own editor\n')
    expect(lastFrame()).not.toContain('NEW CONVERSATION')
    ed.restore()
    done()
    unmount()
  })

  it('w moves a draft to another project before it starts', async () => {
    const { home, cfg, live } = await setup()
    const { lastFrame, stdin, unmount } = render(<App onFocus={onFocus} config={cfg} load={live} />)
    await tick()
    await press(stdin, '\t')
    await press(stdin, 'an idea')
    await press(stdin, '\u001b')
    await onList(lastFrame)
    await press(stdin, 'w')
    expect(lastFrame()).toContain('MOVE TO PROJECT')
    await press(stdin, 'atl')
    await press(stdin, '\r')
    const { listDrafts } = await import('../src/drafts.ts')
    await until(async () => (await listDrafts(home))[0]?.project === 'bh/atlas')
    expect((await listDrafts(home))[0]?.project).toBe('bh/atlas')
    expect(lastFrame()).toContain('Moved to bh/atlas')
    done()
    unmount()
  })

  it('p still goes to Projects with a draft selected', async () => {
    const { cfg, live } = await setup()
    const { lastFrame, stdin, unmount } = render(<App onFocus={onFocus} config={cfg} load={live} />)
    await tick()
    await press(stdin, '\t')
    await press(stdin, 'an idea')
    await press(stdin, '\u001b')
    await onList(lastFrame)
    await press(stdin, 'p')
    expect(lastFrame()).not.toContain('MOVE TO PROJECT')
    expect(focusOf()).toBe('projects')
    done()
    unmount()
  })

  it('an untrusted folder says so and offers T, keeping the draft', async () => {
    const { home, cfg, live } = await setup({ untrusted: true })
    const { lastFrame, stdin, unmount } = render(<App onFocus={onFocus} config={cfg} load={live} />)
    await tick()
    await press(stdin, '\t')
    await press(stdin, 'hello')
    await press(stdin, '\u001b')
    await onList(lastFrame)
    await press(stdin, 's')
    await until(() => (lastFrame() ?? '').includes('T trusts it and starts'))
    expect(lastFrame()).toContain('T trusts it and starts')
    const { listDrafts } = await import('../src/drafts.ts')
    expect((await listDrafts(home)).map((d) => d.text)).toEqual(['hello'])
    done()
    unmount()
  })

  it('conversations opened stay open: moving onto one shows it live, without attaching again', async () => {
    const { cfg, projects, log } = await setup()
    const inbox = projects.find((p) => p.key === 'meta/inbox')!
    const snap: Snapshot = {
      ...snapshot,
      projects,
      items: toItems(
        [
          session({ name: 'First chat', id: 'aaa11111', cwd: inbox.path, state: 'done' }),
          session({ name: 'Second chat', id: 'bbb22222', cwd: inbox.path, state: 'done' }),
        ],
        projects,
      ),
    }
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={cfg} load={async () => snap} />,
    )
    await tick()
    await press(stdin, 'n')
    const said = async (text: string) => {
      await press(stdin, text)
      await press(stdin, '\r')
      await until(() => (lastFrame() ?? '').includes(`you said: ${text}`))
    }
    // Open the selected one and say something, then step back; the same for the next row.
    await press(stdin, '\r')
    await until(() => (lastFrame() ?? '').includes('fake claude screen'))
    const first = /(First|Second) chat/.exec(lastFrame() ?? '')?.[0]
    await said('one')
    await press(stdin, '\u001d')
    await press(stdin, '\u001b[B')
    expect(lastFrame()).not.toContain('you said: one')
    await press(stdin, '\r')
    await until(() => !(lastFrame() ?? '').includes('you said: one'))
    await said('two')
    await press(stdin, '\u001d')
    // Back up: the first is still open and shows as it is, as does the second.
    await press(stdin, '\u001b[A')
    expect(lastFrame()).toContain('you said: one')
    expect(lastFrame()).toContain(first)
    expect(lastFrame()).not.toContain('you said: two')
    await press(stdin, '\u001b[B')
    expect(lastFrame()).toContain('you said: two')
    // ⏎ goes back into the one shown, not the one gone into last.
    await press(stdin, '\u001b[A')
    await press(stdin, '\r')
    await said('three')
    expect(lastFrame()).toContain('you said: one')
    const attaches = (await calls(log)).filter((c) => c.includes('|attach '))
    expect(attaches.map((c) => c.split('|attach ')[1]).sort()).toEqual(['aaa11111', 'bbb22222'])
    done()
    unmount()
  })

  it('e archives a finished conversation, in Hopper’s own state; d does nothing to it', async () => {
    const { home, cfg, projects } = await setup()
    const inbox = projects.find((p) => p.key === 'meta/inbox')!
    const snap: Snapshot = {
      ...snapshot,
      projects,
      items: toItems(
        [session({ name: 'Backups chat', cwd: inbox.path, state: 'done', sessionId: 'sess-1' })],
        projects,
      ),
    }
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={cfg} load={async () => snap} />,
    )
    await tick()
    await press(stdin, 'n')
    expect(lastFrame()).toContain('Backups chat')
    await press(stdin, 'd')
    expect(lastFrame()).not.toContain('Archived: Backups chat')
    await press(stdin, 'e')
    await until(() => (lastFrame() ?? '').includes('Archived: Backups chat'))
    expect(JSON.parse(await readFile(join(home, 'state', 'done.json'), 'utf8'))).toEqual({
      sessions: ['sess-1'],
    })
    done()
    unmount()
  })
})

describe('done', () => {
  it('e archives a conversation at once, without waiting for the load, and back', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hopper-app-'))
    const one = session({ name: 'Backups chat', state: 'done', sessionId: 'sess-1' })
    // The first load, then none that finish: whatever moves after that, the mark moved by itself.
    let loads = 0
    const load = async (): Promise<Snapshot> => {
      if (loads++) await new Promise(() => {})
      return { ...snapshot, items: toItems([one], projects, await loadDone(home)) }
    }
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={{ ...config, home }} load={load} />,
    )
    await tick()
    await press(stdin, 'n')
    await press(stdin, 'e')
    await until(() => (lastFrame() ?? '').includes('Archived: Backups chat'))
    expect(lastFrame()).toContain('Archived: Backups chat')
    await press(stdin, 'n')
    expect(lastFrame()).toContain('Nothing waiting on you.')
    expect([...(await loadDone(home))]).toEqual(['sess-1'])
    await press(stdin, 'v')
    await press(stdin, 'e')
    await until(() => (lastFrame() ?? '').includes('Back in Conversations: Backups chat'))
    expect(lastFrame()).toContain('Back in Conversations: Backups chat')
    await press(stdin, 'n')
    expect(lastFrame()).not.toContain('Nothing waiting on you.')
    unmount()
  })
})

describe('on hold', () => {
  it('h puts a waiting conversation on hold, out of waiting on you, and h takes it off', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hopper-app-'))
    // What gather would make of held.json, on the snapshot above.
    const load = async (): Promise<Snapshot> => {
      const held = await loadHeld(home)
      const items = snapshot.items.map((i) => ({
        ...i,
        ...(i.where === 'needs' && held.has(i.sessionId) ? { held: true } : {}),
      }))
      return { ...snapshot, items }
    }
    const { lastFrame, stdin, unmount } = render(
      <App onFocus={onFocus} config={{ ...config, home }} load={load} />,
    )
    await until(() => (lastFrame() ?? '').includes('WAITING ON YOU 1'))
    expect(lastFrame()).toContain('WAITING ON YOU 1')
    // n goes past the running one at the top, to the one waiting.
    await press(stdin, 'n')
    await press(stdin, 'h')
    await until(() => (lastFrame() ?? '').includes('ON HOLD 1'))
    expect(lastFrame()).not.toContain('WAITING ON YOU')
    expect(lastFrame()).toContain('◷')
    expect([...(await loadHeld(home)).keys()]).toEqual(['s-Draft the spring newsletter'])
    await press(stdin, 'n')
    expect(lastFrame()).toContain('Nothing waiting on you.')
    await press(stdin, 'h')
    await until(() => (lastFrame() ?? '').includes('WAITING ON YOU 1'))
    expect(lastFrame()).not.toContain('ON HOLD')
    expect((await loadHeld(home)).size).toBe(0)
    unmount()
  })
})
