import { homedir } from 'node:os'

import { describe, expect, it } from 'vitest'

import {
  addAccount,
  chosen,
  ConfigError,
  defaultsFor,
  OVERNIGHT_DEFAULTS,
  parseAccounts,
  parsePrefixList,
  parseSettings,
  preferFirst,
  prefixesOf,
  removeAccount,
  serializeAccounts,
  setPrefixes,
  setSetting,
  suggestName,
  type Config,
} from '../src/config.ts'

const base = (): Config => ({
  path: '/c/config.toml',
  accountsPath: '/c/accounts.toml',
  home: '/h',
  accounts: [],
  routes: [],
  overnight: OVERNIGHT_DEFAULTS,
})
const two = (): Config => {
  let c = addAccount(base(), { name: 'bh', label: 'BH', configDir: null })
  c = addAccount(c, { name: 'bh2', label: 'BH two', configDir: '/x/.claude-bh2' })
  return setPrefixes(setPrefixes(c, 'bh', ['bh/', 'meta/']), 'bh2', ['bh/'])
}

describe('settings', () => {
  it('reads home and expands ~', () => {
    expect(parseSettings('home = "~/hop"', '/c.toml').home).toBe(`${homedir()}/hop`)
  })
  it('reports TOML errors with the path', () => {
    expect(() => parseSettings('home = ', '/c.toml')).toThrow(/c\.toml/)
  })
  it('reads the sound, which is optional', () => {
    expect(parseSettings('home = "/h"\nsound = "Pop"', '/c.toml').sound).toBe('Pop')
    expect(parseSettings('home = "/h"', '/c.toml').sound).toBeUndefined()
    expect(() => parseSettings('home = "/h"\nsound = 3', '/c.toml')).toThrow(/sound/)
  })
  it('reads the dim, a whole number from 0 to 80, as a number or a string', () => {
    expect(parseSettings('home = "/h"\ndim = 50', '/c.toml').dim).toBe(50)
    expect(parseSettings('home = "/h"\ndim = "0"', '/c.toml').dim).toBe(0)
    expect(parseSettings('home = "/h"', '/c.toml').dim).toBeUndefined()
    for (const bad of ['81', '-1', '12.5', '"lots"', 'true'])
      expect(() => parseSettings(`home = "/h"\ndim = ${bad}`, '/c.toml')).toThrow(/dim/)
  })
  it('reads what o runs in nvim and where, both optional', () => {
    const s = parseSettings(
      'home = "/h"\ndiff_command = "DiffviewOpen {base}"\nnvim_server = "~/n.sock"',
      '/c.toml',
    )
    expect(s).toMatchObject({ diffCommand: 'DiffviewOpen {base}', nvimServer: '~/n.sock' })
    expect(parseSettings('home = "/h"', '/c.toml').diffCommand).toBeUndefined()
    expect(() => parseSettings('home = "/h"\nnvim_server = ""', '/c.toml')).toThrow(/nvim_server/)
  })
  it('reads the model and effort, which are optional', () => {
    const s = parseSettings('home = "/h"\nmodel = "sonnet"\neffort = "low"', '/c.toml')
    expect(s.model).toBe('sonnet')
    expect(s.effort).toBe('low')
    expect(parseSettings('home = "/h"', '/c.toml').model).toBeUndefined()
    expect(() => parseSettings('home = "/h"\nmodel = 3', '/c.toml')).toThrow(/model/)
  })
  it('reads where drafts are written, hopper or external', () => {
    expect(parseSettings('home = "/h"', '/c.toml').draftEditor).toBeUndefined()
    const s = parseSettings('home = "/h"\ndraft_editor = "external"', '/c.toml')
    expect(s.draftEditor).toBe('external')
    expect(() => parseSettings('home = "/h"\ndraft_editor = "nvim"', '/c.toml')).toThrow(
      /draft_editor/,
    )
  })
  it('always names a model and effort: the draft, else its project, else config, else Hopper', () => {
    expect(defaultsFor(base())).toEqual({ model: 'opus[1m]', effort: 'high' })
    const cfg = { ...base(), model: 'sonnet' }
    expect(defaultsFor(cfg)).toEqual({ model: 'sonnet', effort: 'high' })
    const project = { model: 'haiku', effort: 'low' }
    expect(defaultsFor(cfg, project)).toEqual({ model: 'haiku', effort: 'low' })
    expect(chosen({ model: 'fable' }, defaultsFor(cfg, project))).toEqual({
      model: 'fable',
      effort: 'low',
    })
  })
  it('sets one line and keeps the comments', () => {
    const text = '# Hopper settings.\nhome = "/h"\n\n# The sound.\n'
    const set = setSetting(text, 'sound', 'Pop')
    expect(set).toBe('# Hopper settings.\nhome = "/h"\n\n# The sound.\nsound = "Pop"\n')
    expect(setSetting(set, 'sound', 'off')).toContain('sound = "off"\n')
    expect(setSetting(set, 'sound', null)).toBe('# Hopper settings.\nhome = "/h"\n\n# The sound.\n')
    expect(setSetting(text, 'sound', null)).toBe(text)
  })
})

describe('accounts.toml', () => {
  it('round-trips accounts and routes', () => {
    const c = two()
    const back = parseAccounts(serializeAccounts(c), '/c/accounts.toml')
    expect(back).toEqual({ accounts: c.accounts, routes: c.routes })
    expect(serializeAccounts(c)).toContain('config_dir = "default"')
  })
  it('is empty when there is nothing in it', () => {
    expect(parseAccounts('', '/a.toml')).toEqual({ accounts: [], routes: [] })
  })
  it('rejects a route to an unknown account, and two default logins', () => {
    expect(() =>
      parseAccounts('[[route]]\nprefix = "bh/"\naccounts = ["nope"]\n', '/a.toml'),
    ).toThrow(/unknown account/)
    const twoDefaults =
      '[[account]]\nname = "a"\nconfig_dir = "default"\n[[account]]\nname = "b"\nconfig_dir = "default"\n'
    expect(() => parseAccounts(twoDefaults, '/a.toml')).toThrow(/only one account/)
  })
})

describe('edits', () => {
  it('refuses a taken name or a directory another account uses', () => {
    const c = two()
    expect(() => addAccount(c, { name: 'bh', label: '', configDir: '/y' })).toThrow(ConfigError)
    expect(() => addAccount(c, { name: 'pm', label: '', configDir: null })).toThrow(/default login/)
    expect(() => addAccount(c, { name: 'Bad Name', label: '', configDir: '/z' })).toThrow(
      /lowercase/,
    )
  })
  it('puts an account joining a route last, and preferFirst moves it up', () => {
    const c = two()
    expect(c.routes).toEqual([
      { prefix: 'bh/', accounts: ['bh', 'bh2'] },
      { prefix: 'meta/', accounts: ['bh'] },
    ])
    expect(preferFirst(c, 'bh2').routes[0]).toEqual({ prefix: 'bh/', accounts: ['bh2', 'bh'] })
    expect(prefixesOf(c, 'bh2')).toEqual([{ prefix: 'bh/', rank: 1 }])
  })
  it('setPrefixes takes an account off routes it no longer lists, and drops empty routes', () => {
    const c = setPrefixes(two(), 'bh', ['bh/'])
    expect(c.routes).toEqual([{ prefix: 'bh/', accounts: ['bh', 'bh2'] }])
  })
  it('removing an account takes it off every route', () => {
    const c = removeAccount(two(), 'bh')
    expect(c.accounts.map((a) => a.name)).toEqual(['bh2'])
    expect(c.routes).toEqual([{ prefix: 'bh/', accounts: ['bh2'] }])
  })
})

describe('parsePrefixList', () => {
  it('normalises, dedupes, and reads * as everything', () => {
    expect(parsePrefixList('bh, bh/news/  meta/, bh/, *')).toEqual(['bh/', 'bh/news/', 'meta/', ''])
  })
  it('rejects things that are not prefixes', () => {
    expect(() => parsePrefixList('BH Stuff')).toThrow(ConfigError)
  })
})

describe('suggestName', () => {
  it('uses the org initials, the email, or claude, and avoids taken names', () => {
    expect(suggestName({ orgName: 'Blue Heron' }, [])).toBe('bh')
    expect(suggestName({ orgName: 'Blue Heron' }, ['bh'])).toBe('bh2')
    expect(suggestName({ orgName: 'Pinemoor' }, [])).toBe('pinemo')
    expect(suggestName({ email: 'sam@example.com' }, [])).toBe('sam')
    expect(suggestName(null, [])).toBe('claude')
  })
})

describe('providers', () => {
  it('defaults to claude-code, writes it out, and refuses one this build does not know', () => {
    const c = parseAccounts('[[account]]\nname = "bh"\n', '/a.toml')
    expect(serializeAccounts({ ...c })).toContain('provider = "claude-code"')
    expect(() =>
      parseAccounts('[[account]]\nname = "local"\nprovider = "ollama"\n', '/a.toml'),
    ).toThrow(/knows claude-code/)
  })
})

describe('the default account', () => {
  it('runs every key no other route names, and can be changed', async () => {
    const { defaultAccount, setDefaultAccount } = await import('../src/config.ts')
    const { routeFor } = await import('../src/routing.ts')
    let c = two()
    expect(defaultAccount(c)).toBeUndefined()
    c = setDefaultAccount(c, 'bh2')
    expect(defaultAccount(c)).toBe('bh2')
    expect(routeFor(c, 'pm/ledger')?.accounts).toEqual(['bh2'])
    expect(routeFor(c, 'bh/atlas')?.prefix).toBe('bh/') // a named route still wins
    c = setDefaultAccount(c, 'bh')
    expect(c.routes.find((r) => r.prefix === '')?.accounts).toEqual(['bh', 'bh2'])
    expect(() => setDefaultAccount(c, 'nope')).toThrow(/No account/)
  })
})

describe('account order', () => {
  it('keeps accounts alphabetical, as read and as added', async () => {
    const { addAccount, parseAccounts } = await import('../src/config.ts')
    const read = parseAccounts(
      '[[account]]\nname = "pm"\nconfig_dir = "~/.claude-pm"\n[[account]]\nname = "bh"\n',
      '/c/accounts.toml',
    )
    expect(read.accounts.map((a) => a.name)).toEqual(['bh', 'pm'])
    const config = { path: '', accountsPath: '', home: '', overnight: OVERNIGHT_DEFAULTS, ...read }
    const added = addAccount(config, { name: 'ax', label: 'ax', configDir: '/tmp/ax' })
    expect(added.accounts.map((a) => a.name)).toEqual(['ax', 'bh', 'pm'])
  })
})
