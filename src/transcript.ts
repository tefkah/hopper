import { access, open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Which model a conversation's replies actually came from, and when the newest came. Hopper asks for an alias (opus,
// opus[1m]) and Claude Code resolves it; each reply in the session's transcript carries the full
// id it ran on (claude-opus-5-5). The transcript doesn't say whether [1m] was on: that is a
// setting of the request, not part of the model's name.
//
// Also when its newest message came, either way, and when I last wrote to it: what the lists
// sort by. Not the file's mtime: Claude Code appends its own bookkeeping (cost-state,
// away_summary, …) long after the last message.

// <config dir>/projects/<cwd, every other character a dash>/<session id>.jsonl. The default
// login's config dir is ~/.claude.
export const transcriptPath = (configDir: string | null, cwd: string, sessionId: string) =>
  join(
    configDir ?? join(homedir(), '.claude'),
    'projects',
    cwd.replace(/[^A-Za-z0-9]/g, '-'),
    `${sessionId}.jsonl`,
  )

// A session that enters a worktree carries on in the worktree's folder, so its transcript can
// sit under any folder of the login's projects/. Where one was found is kept, and a search that
// found nothing isn't repeated for a minute.
const found = new Map<string, string>()
const missed = new Map<string, number>()
const RETRY = 60_000

export async function findTranscript(
  configDir: string | null,
  cwd: string,
  sessionId: string,
  now = Date.now(),
): Promise<string | null> {
  const there = (p: string) =>
    access(p).then(
      () => true,
      () => false,
    )
  const known = found.get(sessionId)
  if (known && (await there(known))) return known
  const direct = transcriptPath(configDir, cwd, sessionId)
  if (await there(direct)) return direct
  if ((missed.get(sessionId) ?? 0) > now - RETRY) return null
  const projects = join(configDir ?? join(homedir(), '.claude'), 'projects')
  for (const dir of await readdir(projects).catch(() => [])) {
    const p = join(projects, dir, `${sessionId}.jsonl`)
    if (await there(p)) {
      found.set(sessionId, p)
      missed.delete(sessionId)
      return p
    }
  }
  missed.set(sessionId, now)
  return null
}

// Replies are near the end, so the file is read back from there a piece at a time: a long tool
// output can push the last one further back, and a transcript can run past 100 MB.
const CHUNK = 256 * 1024
// A reply's model, written as JSON. Quotes inside a tool's output are escaped, so they don't match.
const MODEL = /"model":"([^"]+)"/g
// A message, mine or Claude's (a tool's result is written as one of mine), rather than an entry
// Claude Code keeps for itself.
const MESSAGE = /"type":"(user|assistant)"/
// Of mine, the ones that aren't something I wrote: a tool's result, or text Claude Code adds.
const NOT_WRITTEN = /"toolUseResult":|"type":"tool_result"|"isMeta":true/
// When Claude Code wrote the entry, on the same line.
const STAMP = /"timestamp":"([^"]+)"/
// What Claude Code writes for a message it made up itself (an error, an interruption).
const SYNTHETIC = '<synthetic>'

export type Reply = { model: string; at: number | null }
export type Transcript = {
  // The newest reply, or null when there isn't one yet.
  reply: Reply | null
  // When the newest message was written, or null when none says.
  activeAt: number | null
  // When I last wrote to it (Hopper's first prompt counts), or null when none says.
  promptedAt: number | null
}

function readLines(text: string): Transcript {
  let reply: Reply | null = null
  let activeAt: number | null = null
  let promptedAt: number | null = null
  for (const line of text.split('\n')) {
    const stamp = Date.parse(STAMP.exec(line)?.[1] ?? '')
    const at = Number.isNaN(stamp) ? null : stamp
    const message = MESSAGE.exec(line)?.[1]
    if (at !== null && message) activeAt = at
    if (at !== null && message === 'user' && !NOT_WRITTEN.test(line)) promptedAt = at
    let model: string | null = null
    for (const m of line.matchAll(MODEL)) if (m[1] && m[1] !== SYNTHETIC) model = m[1]
    if (model) reply = { model, at }
  }
  return { reply, activeAt, promptedAt }
}

const complete = (t: Transcript) => !!t.reply && t.activeAt !== null && t.promptedAt !== null

// What `older` says, where `newer` (read from later in the file) says nothing.
const fill = (newer: Transcript, older: Transcript | null): Transcript => ({
  reply: newer.reply ?? older?.reply ?? null,
  activeAt: newer.activeAt ?? older?.activeAt ?? null,
  promptedAt: newer.promptedAt ?? older?.promptedAt ?? null,
})

// Reads back from `end` a chunk at a time until it knows all three, or reaches `floor`. A line
// the chunk's start cuts through waits for the chunk before it. Only one chunk and the line
// being finished are in memory, not the file: at startup every transcript is read at once.
async function readBack(f: FileHandle, end: number, floor: number): Promise<Transcript> {
  let found: Transcript = { reply: null, activeAt: null, promptedAt: null }
  let cut: Buffer[] = []
  while (end > floor && !complete(found)) {
    const from = Math.max(floor, end - CHUNK)
    const buf = Buffer.alloc(end - from)
    await f.read(buf, 0, buf.length, from)
    end = from
    // At the start of the file the first line is whole. Anywhere else it's cut, and at the
    // floor it began where the last read already looked, so it's left out.
    const whole = from === 0
    const nl = whole ? -1 : buf.indexOf(10)
    if (!whole && nl === -1) {
      if (from === floor) break
      cut.unshift(buf)
      continue
    }
    const text = Buffer.concat([buf.subarray(nl + 1), ...cut]).toString('utf8')
    cut = whole ? [] : [buf.subarray(0, nl)]
    found = fill(found, readLines(text))
  }
  return found
}

// Read again only when the file has changed, since every poll asks.
const cache = new Map<string, { size: number; mtimeMs: number; read: Transcript }>()

// The newest reply, when the newest message came and when I last wrote, or null when there is
// no transcript.
export async function readTranscript(path: string): Promise<Transcript | null> {
  const s = await stat(path).catch(() => null)
  if (!s) return null
  const hit = cache.get(path)
  if (hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs) return hit.read
  const f = await open(path, 'r')
  try {
    // A transcript only grows, so what an earlier read found still holds where what was added
    // since says nothing newer: a long turn's tool output can push my prompt far back, and
    // reading that far on every poll while it works would be the cost of that. The read goes a
    // chunk past where the last one ended, for the line that was being written then.
    const before = hit && s.size >= hit.size ? hit.read : null
    const floor = before && hit ? Math.max(0, hit.size - CHUNK) : 0
    const found = fill(await readBack(f, s.size, floor), before)
    cache.set(path, { size: s.size, mtimeMs: s.mtimeMs, read: found })
    return found
  } finally {
    await f.close()
  }
}
