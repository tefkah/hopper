import { execFile, spawn } from 'node:child_process'
import { access, constants, mkdir, rm, stat } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'

import {
  ChangesError,
  DIFF_DEFAULT,
  editedHere,
  exArg,
  fillCommand,
  firstChanged,
  needsSides,
  readWorked,
  workedIn,
  writeSides,
  type Git,
} from './changes.ts'
import { expandHome, tildify } from './paths.ts'

// Opening nvim on a folder with a command to run, for d. Where, in order: a running nvim that
// listens on the socket config.toml names (a new tab there; Hopper stays on screen), else a new
// Ghostty window when Hopper runs in Ghostty on macOS, else Hopper steps aside and nvim runs in
// its terminal until it quits.

export type Ran = { code: number | null; stdout: string; stderr: string }
// Runs a program to its end; injected, so tests don't start editors.
export type Run = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<Ran>

export const run: Run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeout ?? 10_000, env: opts.env ?? process.env, encoding: 'utf8' },
      (err, stdout, stderr) =>
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout,
          stderr: stderr || (err?.message ?? ''),
        }),
    )
  })

// nvim's full path, so a window that doesn't start from my shell finds the same one.
export async function findNvim(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, 'nvim')
    try {
      await access(p, constants.X_OK)
      if ((await stat(p)).isFile()) return p
    } catch {}
  }
  return null
}

// Keys for nvim's --remote-send: < starts a key's name there, so a literal one is <lt>.
const keys = (s: string) => s.replace(/</g, '<lt>')

// What a running nvim is sent: back to normal mode from wherever it is, a new tab, that tab's
// folder, then the command.
export const remoteKeys = (dir: string, command: string) =>
  `<C-\\><C-N>:tabnew<CR>:tcd ${keys(exArg(dir))}<CR>:${keys(command)}<CR>`

// Single quotes for /bin/sh.
export const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// A new Ghostty window (1.3 and later answer AppleScript): its folder, the command it runs instead
// of a shell, and my PATH, since a window Ghostty starts doesn't read my shell's. The window
// closes when nvim quits. The arguments come in as argv, so nothing needs quoting for AppleScript.
export const GHOSTTY_SCRIPT = `on run argv
  tell application "Ghostty"
    set cfg to new surface configuration
    set initial working directory of cfg to item 1 of argv
    set command of cfg to item 2 of argv
    set environment variables of cfg to {item 3 of argv}
    new window with configuration cfg
  end tell
end run`

export const ghosttyArgs = (dir: string, nvim: string, command: string, path: string) => [
  '-e',
  GHOSTTY_SCRIPT,
  dir,
  `${sh(nvim)} -c ${sh(command)}`,
  `PATH=${path}`,
]

export type Where = 'server' | 'ghostty' | 'here'

// Where `hopper nvim` listens, and so where d looks first when config.toml names no socket.
export const NVIM_SERVER_DEFAULT = '~/.cache/hopper/nvim.sock'

// `hopper nvim [args]`: nvim, listening where d looks, so what d opens comes to it as a new tab.
// A socket left by an nvim that quit is cleared first; with another one still listening there,
// this one runs without listening, and says so. nvim's own exit code.
export async function nvimListening(
  args: string[],
  server: string | undefined,
  o: { run?: Run; env?: NodeJS.ProcessEnv; say?: (s: string) => void } = {},
): Promise<number> {
  const exec = o.run ?? run
  const say = o.say ?? ((s: string) => console.error(s))
  const nvim = await findNvim(o.env)
  if (!nvim) {
    say('nvim isn’t on the PATH.')
    return 1
  }
  const sock = expandHome(server ?? NVIM_SERVER_DEFAULT)
  let listen = true
  const there = await access(sock).then(
    () => true,
    () => false,
  )
  if (there) {
    const alive = await exec(nvim, ['--server', sock, '--remote-expr', '1'], { timeout: 2000 })
    if (alive.code === 0 && alive.stdout.trim() === '1') {
      say(`Another nvim already listens at ${tildify(sock)}: d keeps opening there.`)
      listen = false
    } else await rm(sock, { force: true })
  } else await mkdir(dirname(sock), { recursive: true })
  return new Promise((resolve) => {
    const child = spawn(nvim, [...(listen ? ['--listen', sock] : []), ...args], {
      stdio: 'inherit',
    })
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

export type OpenOpts = {
  dir: string
  // An Ex command, run in dir.
  command: string
  nvim: string
  // config.toml's nvim_server, else NVIM_SERVER_DEFAULT: a socket a running nvim listens on.
  server?: string | undefined
  // The default socket, not one config.toml names: nobody listening there is no news.
  optional?: boolean
  // Whether a Ghostty window can be had: macOS, with Hopper running in Ghostty.
  ghostty: boolean
  env?: NodeJS.ProcessEnv
  run?: Run
  // nvim in Hopper's own terminal, with Hopper out of the way until it quits.
  here: (nvim: string, args: string[], dir: string) => Promise<void>
}

// Where it opened, and what went wrong on the way there, if anything.
export async function openNvim(o: OpenOpts): Promise<{ where: Where; note?: string }> {
  const exec = o.run ?? run
  const env = o.env ?? process.env
  const notes: string[] = []
  if (o.server) {
    const sock = expandHome(o.server)
    // A socket nobody listens on any more is common (an nvim closed since): ask first, briefly.
    const alive = await exec(o.nvim, ['--server', sock, '--remote-expr', '1'], { timeout: 2000 })
    if (alive.code === 0 && alive.stdout.trim() === '1') {
      const sent = await exec(o.nvim, [
        '--server',
        sock,
        '--remote-send',
        remoteKeys(o.dir, o.command),
      ])
      if (sent.code === 0) return { where: 'server' }
      notes.push(`nvim at ${tildify(sock)} didn't take it`)
    } else if (!o.optional) notes.push(`no nvim at ${tildify(sock)}`)
  }
  if (o.ghostty) {
    const r = await exec('osascript', ghosttyArgs(o.dir, o.nvim, o.command, env['PATH'] ?? ''))
    if (r.code === 0)
      return { where: 'ghostty', ...(notes.length ? { note: notes.join('; ') } : {}) }
    notes.push(`Ghostty didn't open a window (${firstLine(r.stderr)})`)
  }
  await o.here(o.nvim, ['-c', o.command], o.dir)
  return { where: 'here', ...(notes.length ? { note: notes.join('; ') } : {}) }
}

const WHERE: Record<Where, string> = {
  server: 'a new tab of the running nvim',
  ghostty: 'a new Ghostty window',
  here: 'nvim',
}

// d, from the conversation to nvim: where it worked (its transcript), what changed there, the
// command filled in, then nvim. Returns what to tell the person.
export async function openChanges(o: {
  // Its transcript, when there is one, and the folder Claude reports it in.
  transcript: string | null
  cwd: string
  template?: string | undefined
  server?: string | undefined
  optional?: boolean
  ghostty: boolean
  // Where {left} and {right} are made, the conversation's own folder.
  sides: string
  run?: Run
  git?: Git
  env?: NodeJS.ProcessEnv
  here: OpenOpts['here']
}): Promise<string> {
  try {
    const worked = o.transcript ? await readWorked(o.transcript) : { cwd: null, edited: [] }
    const changes = await firstChanged(await workedIn(worked, o.cwd, o.git), o.git)
    const dir = changes.dir
    const what = `${tildify(dir)}${changes.branch ? ` (${changes.branch})` : ''}`
    if (!changes.files.length) return `Nothing changed in ${what}, ${changes.since}.`
    const nvim = await findNvim(o.env)
    if (!nvim) return 'nvim isn’t on the PATH.'
    const template = o.template ?? DIFF_DEFAULT
    const command = fillCommand(template, {
      dir,
      base: changes.base,
      files: editedHere(changes, worked.edited),
      ...(needsSides(template) ? await writeSides(changes, o.sides) : {}),
    })
    const opened = await openNvim({
      dir,
      command,
      nvim,
      server: o.server,
      ...(o.optional ? { optional: true } : {}),
      ghostty: o.ghostty,
      ...(o.env ? { env: o.env } : {}),
      ...(o.run ? { run: o.run } : {}),
      here: o.here,
    })
    const n = changes.files.length
    const said = `${n} file${n === 1 ? '' : 's'} in ${what}, ${changes.since}: ${WHERE[opened.where]}.`
    return opened.note ? `${said} (${opened.note})` : said
  } catch (e) {
    return e instanceof ChangesError
      ? e.message
      : `Couldn't open its changes: ${(e as Error).message}`
  }
}

const firstLine = (s: string) => s.trim().split('\n')[0]?.slice(0, 80) || 'no reason given'

// Whether o can open a Ghostty window: Ghostty sets TERM_PROGRAM in what it runs.
export const inGhostty = (env: NodeJS.ProcessEnv = process.env, platform = process.platform) =>
  platform === 'darwin' && env['TERM_PROGRAM'] === 'ghostty'
