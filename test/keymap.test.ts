import { describe, expect, it } from 'vitest'

import { CHOICE_DEFAULTS } from '../src/config.ts'
import type { Item } from '../src/model.ts'
import { barKeys, hereKeys, type Here } from '../src/tui/keymap.ts'

const base: Here = {
  focus: 'work',
  scope: null,
  embedOpen: false,
  summaryShown: true,
  untrusted: false,
  editing: null,
  defaults: CHOICE_DEFAULTS,
}
const conversation = { id: 'abc', kind: 'background', where: 'needs' } as Item
const keysOf = (h: Partial<Here>) => hereKeys({ ...base, ...h }).hints.map(([k]) => k)

describe('hereKeys', () => {
  it('follows what is selected in the list', () => {
    expect(keysOf({ item: conversation })).toEqual(['⏎ →', 'e', 'd', 'h', 'J K'])
    expect(keysOf({ item: conversation, embedOpen: true })).toEqual([
      '⏎ →',
      'i',
      'e',
      'd',
      'h',
      'J K',
    ])
    expect(keysOf({ focus: 'done', item: conversation })).toEqual(['⏎ →', 'e', 'd'])
  })
  it('offers h on what waits on you, off hold on what is held, and nothing on running work', () => {
    expect(hereKeys({ ...base, item: conversation }).hints).toContainEqual(['h', 'on hold'])
    const held = { ...conversation, held: true } as Item
    expect(hereKeys({ ...base, item: held }).hints).toContainEqual(['h', 'off hold'])
    expect(keysOf({ item: { ...conversation, where: 'queue' } as Item })).not.toContain('h')
  })
  it('offers tab in Projects only on a project, and esc on the list only when it is narrowed', () => {
    const row = (isProject: boolean) => ({ key: 'pm', isProject }) as Here['row']
    expect(keysOf({ focus: 'projects', row: row(true) })).toEqual(['⏎', 'tab', '↑↓', 'esc'])
    expect(keysOf({ focus: 'projects', row: row(false) })).toEqual(['⏎', '↑↓', 'esc'])
    expect(keysOf({ item: conversation, scope: 'pm' })).toEqual([
      '⏎ →',
      'e',
      'd',
      'h',
      'J K',
      'esc',
    ])
    expect(keysOf({ item: conversation })).not.toContain('esc')
  })
  it("offers a report's conversation only while Claude still has it", () => {
    const list = hereKeys({ ...base, reports: { reading: false, conversation: false } })
    expect(list.label).toBe('routine reports')
    expect(list.hints.map(([k]) => k)).toEqual(['j k ↑↓', '⏎ →', 'm', 'M', 'esc ←'])
    const reading = hereKeys({ ...base, reports: { reading: true, conversation: true } })
    expect(reading.label).toBe('a report')
    expect(reading.hints).toContainEqual(['c', 'its conversation'])
    // The reports keep the keyboard, so the bar shows their keys and nothing else.
    expect(barKeys({ ...base, reports: { reading: true, conversation: true } })).toEqual(
      reading.hints,
    )
  })
  it('knows a conversation, a draft on the list, and writing one', () => {
    expect(hereKeys({ ...base, focus: 'session' }).label).toBe('a conversation')
    expect(hereKeys({ ...base, focus: 'session' }).hints).toContainEqual([
      'ctrl+\\',
      'what it changed, in nvim',
    ])
    const draft = { kind: 'draft', model: 'opus' } as Item
    const hints = hereKeys({ ...base, item: draft }).hints
    expect(hints).toContainEqual(['m', 'model: opus'])
    // One that picks none says what it falls back to.
    const unset = hereKeys({ ...base, item: { kind: 'draft' } as Item }).hints
    expect(unset).toContainEqual(['m', 'model: opus[1m] (default)'])
    expect(unset).toContainEqual(['E', 'effort: high (default)'])
    expect(hints).toContainEqual(['s', 'start it'])
    expect(hints).toContainEqual(['e', 'throw away'])
    const editing = { stage: 'write' } as Here['editing']
    expect(hereKeys({ ...base, editing }).hints).toContainEqual(['esc', 'save and close'])
  })
  it('leaves out of the key bar what the screen already shows', () => {
    // The summary lists ⏎ and d, leaving → of "⏎ →".
    expect(barKeys({ ...base, item: conversation }).map(([k]) => k)).toEqual(['→', 'J K'])
    // With the conversation open instead, nothing on the right lists them.
    expect(
      barKeys({ ...base, item: conversation, embedOpen: true, summaryShown: false }).map(
        ([k]) => k,
      ),
    ).toEqual(['⏎ →', 'i', 'e', 'd', 'h', 'J K'])
    expect(barKeys({ ...base, focus: 'accounts' })).toEqual([])
  })
})
