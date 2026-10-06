import { spawn, type SpawnOptions } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { readIfThere, writeAtomic } from '../fsutil.ts'
import { MOUSE_OFF, MOUSE_ON } from './mouse.ts'

type Suspend = (fn: () => Promise<void>) => Promise<void>

// The person's own editor: $VISUAL, else $EDITOR, else vi. It may carry flags ("code --wait"),
// so it runs through the shell.
const editorCommand = () => process.env['VISUAL'] || process.env['EDITOR'] || 'vi'
// Its name, for saying so: "nvim", not its path or flags.
export const editorName = () => basename(editorCommand().trim().split(/\s+/)[0] ?? '') || 'vi'

const quoted = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`

// Hands Hopper's terminal to a program until it exits: Ink steps aside, and mouse reporting is
// off so the program gets the terminal as it would from a shell (the mouse codes only to a
// terminal: tests come through here too). Whether it exited cleanly.
export async function runInTerminal(
  suspend: Suspend,
  cmd: string,
  args: string[],
  opts: Pick<SpawnOptions, 'cwd' | 'shell'> = {},
): Promise<boolean> {
  let ok = false
  await suspend(async () => {
    if (process.stdout.isTTY) process.stdout.write(MOUSE_OFF)
    ok = await new Promise<boolean>((resolve) => {
      const child = spawn(cmd, args, { ...opts, stdio: 'inherit' })
      child.on('exit', (code) => resolve(code === 0))
      child.on('error', () => resolve(false))
    })
    if (process.stdout.isTTY) process.stdout.write(MOUSE_ON)
  })
  return ok
}

// The editor on `path`. Whether it exited cleanly: vim's :cq, or an editor that wouldn't start,
// is not.
export const runEditor = (suspend: Suspend, path: string): Promise<boolean> =>
  runInTerminal(suspend, `${editorCommand()} ${quoted(path)}`, [], { shell: true })

// Some text written in the editor: only the text, in a file of its own named `name`.md, so the
// front matter around it on disk can't be broken. What was saved comes back without its trailing
// blank lines; null when the editor quit with an error, which leaves the text as it was.
export async function editText(
  suspend: Suspend,
  text: string,
  name: string,
): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), 'hopper-edit-'))
  const path = join(dir, `${name}.md`)
  try {
    await writeAtomic(path, text && !text.endsWith('\n') ? text + '\n' : text)
    if (!(await runEditor(suspend, path))) return null
    return ((await readIfThere(path)) ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
