import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { findTranscript, readTranscript, transcriptPath } from '../src/transcript.ts'

const lastReply = async (path: string) => (await readTranscript(path))?.reply ?? null

const reply = (model: string, text = 'ok') =>
  JSON.stringify({
    type: 'assistant',
    message: { model, role: 'assistant', content: [{ text }] },
  }) + '\n'

describe('transcripts', () => {
  it('sits under the login, its folder named for the cwd with every other character a dash', () => {
    expect(transcriptPath('/c/.claude-sb', '/Users/me/proj_x/.claude', 'abc')).toBe(
      '/c/.claude-sb/projects/-Users-me-proj-x--claude/abc.jsonl',
    )
    expect(transcriptPath(null, '/w', 'abc')).toBe(join(homedir(), '.claude/projects/-w/abc.jsonl'))
  })
  it('reads the newest reply’s model, skipping made-up messages and quoted text', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'hopper-transcript-')), 's.jsonl')
    expect(await lastReply(path)).toBeNull()
    await writeFile(path, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n')
    expect(await lastReply(path)).toBeNull()
    await appendFile(path, reply('claude-sonnet-5-5'))
    await appendFile(path, reply('claude-opus-5-5', 'it said "model":"claude-haiku" once'))
    await appendFile(path, reply('<synthetic>'))
    expect((await lastReply(path))?.model).toBe('claude-opus-5-5')
    // A change to the file is read again.
    await appendFile(path, reply('claude-fable-5-1'))
    expect((await lastReply(path))?.model).toBe('claude-fable-5-1')
  })
  it('says when the newest reply came, from its own line', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'hopper-transcript-')), 's.jsonl')
    const at = (model: string, timestamp: string) =>
      JSON.stringify({ type: 'assistant', message: { model }, timestamp }) + '\n'
    await writeFile(path, at('claude-opus-5-5', '2026-09-30T10:00:00.000Z'))
    await appendFile(
      path,
      JSON.stringify({ type: 'user', timestamp: '2026-09-30T11:00:00Z' }) + '\n',
    )
    expect(await lastReply(path)).toEqual({
      model: 'claude-opus-5-5',
      at: Date.parse('2026-09-30T10:00:00.000Z'),
    })
    await appendFile(path, reply('claude-opus-5-5'))
    expect((await lastReply(path))?.at).toBeNull()
  })
  it('says when the newest message came, either way, past Claude Code’s own entries', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'hopper-transcript-')), 's.jsonl')
    expect(await readTranscript(path)).toBeNull()
    const line = (o: object) => JSON.stringify(o) + '\n'
    await writeFile(path, line({ type: 'user', message: {}, timestamp: '2026-09-30T09:00:00Z' }))
    await appendFile(
      path,
      line({
        type: 'assistant',
        message: { model: 'claude-opus-5-5' },
        timestamp: '2026-09-30T10:00:00Z',
      }),
    )
    await appendFile(path, line({ type: 'system', timestamp: '2026-09-30T12:00:00Z' }))
    await appendFile(path, line({ type: 'cost-state' }))
    expect((await readTranscript(path))?.activeAt).toBe(Date.parse('2026-09-30T10:00:00Z'))
    // My reply counts, though Claude hasn't answered it yet.
    await appendFile(path, line({ type: 'user', message: {}, timestamp: '2026-09-30T13:00:00Z' }))
    expect(await readTranscript(path)).toEqual({
      reply: { model: 'claude-opus-5-5', at: Date.parse('2026-09-30T10:00:00Z') },
      activeAt: Date.parse('2026-09-30T13:00:00Z'),
      promptedAt: Date.parse('2026-09-30T13:00:00Z'),
    })
  })
  it('says when I last wrote to it, not counting tools’ results or Claude Code’s own text', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'hopper-transcript-')), 's.jsonl')
    const line = (o: object) => JSON.stringify(o) + '\n'
    await writeFile(
      path,
      line({
        type: 'user',
        message: { content: 'it said "isMeta":true once' },
        timestamp: '2026-09-30T09:00:00Z',
      }),
    )
    await appendFile(
      path,
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'ok' }] },
        toolUseResult: { stdout: 'ok' },
        timestamp: '2026-09-30T10:00:00Z',
      }),
    )
    await appendFile(
      path,
      line({ type: 'user', isMeta: true, message: {}, timestamp: '2026-09-30T11:00:00Z' }),
    )
    expect(await readTranscript(path)).toMatchObject({
      activeAt: Date.parse('2026-09-30T11:00:00Z'),
      promptedAt: Date.parse('2026-09-30T09:00:00Z'),
    })
  })
  it('finds my prompt after a long turn pushes it out of the end of the file', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'hopper-transcript-')), 's.jsonl')
    const line = (o: object) => JSON.stringify(o) + '\n'
    await writeFile(path, line({ type: 'user', message: {}, timestamp: '2026-09-30T09:00:00Z' }))
    await appendFile(path, reply('claude-opus-5-5'))
    expect((await readTranscript(path))?.promptedAt).toBe(Date.parse('2026-09-30T09:00:00Z'))
    const output = 'x'.repeat(150 * 1024)
    for (const timestamp of ['2026-09-30T09:30:00Z', '2026-09-30T10:00:00Z'])
      await appendFile(
        path,
        line({
          type: 'user',
          message: { content: [{ type: 'tool_result', content: output }] },
          toolUseResult: {},
          timestamp,
        }),
      )
    expect(await readTranscript(path)).toMatchObject({
      reply: { model: 'claude-opus-5-5' },
      activeAt: Date.parse('2026-09-30T10:00:00Z'),
      promptedAt: Date.parse('2026-09-30T09:00:00Z'),
    })
  })
  it('reads back from the end of a long one, across lines longer than what it reads at once', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'hopper-transcript-')), 's.jsonl')
    const line = (o: object) => JSON.stringify(o) + '\n'
    // A line in every message and a few the pieces cut through, some longer than a piece.
    let text = line({ type: 'user', message: {}, timestamp: '2026-09-30T08:00:00Z' })
    text += line({ type: 'user', message: { content: 'é' }, timestamp: '2026-09-30T09:00:00Z' })
    text += reply('claude-opus-5-5')
    for (const [i, size] of [100, 700, 90, 300, 2].entries())
      text += line({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'ü'.repeat(size * 512) }] },
        toolUseResult: {},
        timestamp: `2026-09-30T10:0${i}:00Z`,
      })
    await writeFile(path, text)
    expect(await readTranscript(path)).toEqual({
      reply: { model: 'claude-opus-5-5', at: null },
      activeAt: Date.parse('2026-09-30T10:04:00Z'),
      promptedAt: Date.parse('2026-09-30T09:00:00Z'),
    })
  })
  it('finds one that moved to a worktree’s folder', async () => {
    const login = await mkdtemp(join(tmpdir(), 'hopper-login-'))
    const moved = join(login, 'projects', '-w--claude-worktrees-x')
    await mkdir(moved, { recursive: true })
    await writeFile(join(moved, 'sid.jsonl'), reply('claude-opus-5-5'))
    expect(await findTranscript(login, '/w', 'sid')).toBe(join(moved, 'sid.jsonl'))
    expect(await findTranscript(login, '/w', 'nope')).toBeNull()
  })
})
