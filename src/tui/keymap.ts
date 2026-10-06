// What the keys do, in one place: the key bar shows the ones for where you are, and the help
// screen (?) shows those first and then all of them. keys.ts is what acts on them; keep the two
// in step.

import type { ProjectRow } from '../active.ts'
import { canKeepAwake } from '../awake.ts'
import { choiceText, type Choice } from '../config.ts'
import type { Item } from '../model.ts'
import type { Row } from '../settings.ts'
import { groupOf, type Editing, type Focus } from './state.ts'

export type Hint = [key: string, does: string]

// Where the keyboard is, as much as the hints need to know.
export type Here = {
  focus: Focus
  row?: ProjectRow | undefined
  item?: Item | undefined
  scope: string | null
  // The selected item's conversation is the one showing on the right.
  embedOpen: boolean
  // The right panel shows the summary of what's selected, which lists its own keys.
  summaryShown: boolean
  untrusted: boolean
  editing: Editing | null
  // What the selected draft or routine falls back to for a model and effort it doesn't pick.
  defaults: Choice
  // Set while the settings screen is open: the row selected there.
  setting?: Row | null | undefined
  // Set while a routine's list (its prompt, then its reports) has the keyboard: reading a report,
  // on the prompt's line, and whether the selected report's conversation is still there to open.
  reports?: { reading: boolean; onPrompt?: boolean; conversation: boolean } | undefined
}

export const ANYWHERE: Hint[] = [
  ['?', 'all keys'],
  ['tab', 'new conversation'],
  ['n', 'next waiting on you'],
  ['p', 'projects: type to find one'],
  ['c', 'conversations'],
  ['v', 'archived'],
  ['a', 'accounts'],
  ['→ ←', 'into a conversation and back'],
  [',', 'settings'],
  ...(canKeepAwake ? [['z', 'keep this Mac awake, or let it sleep'] as Hint] : []),
  ['R', 'refresh'],
  ['esc', 'back'],
  ['x x', 'quit'],
]

// Every key of each panel, for the help screen.
export const PANEL_KEYS: [label: string, hints: Hint[]][] = [
  [
    'projects',
    [
      ['type', 'find a project or a folder'],
      ['↑↓', 'move'],
      ['⏎', 'narrow the list to it'],
      ['tab', 'new conversation there'],
      ['esc →', 'back to the list'],
    ],
  ],
  [
    'the list',
    [
      ['j k', 'move'],
      ['J K', 'next group (shift+↑↓)'],
      ['⏎ →', 'open it, or go back in'],
      ['e', 'archive'],
      ['h', 'on hold, or off it (a reply takes it off too)'],
      ['d ctrl+\\', 'what it changed, in nvim'],
      ['i', 'interrupt (sends esc)'],
      ['u', 'a draft: up next, tonight, off'],
      ['U', 'queue every proposal tonight'],
      ['g', 'dispatch up next now'],
      ['esc', 'every project again'],
    ],
  ],
  [
    'archived',
    [
      ['⏎ →', 'open it here'],
      ['e', 'bring it back'],
      ['d ctrl+\\', 'what it changed, in nvim'],
    ],
  ],
  [
    'accounts',
    [
      ['⏎', 'sign in'],
      ['a', 'add one'],
      ['e', 'prefixes it runs'],
      ['1', 'first on its prefixes'],
      ['*', 'make it the default'],
      ['u', 'fresh usage'],
      ['r', 'rename'],
      ['d', 'remove'],
    ],
  ],
]

export const SETTINGS_KEYS: Hint[] = [
  ['j k', 'move'],
  ['J K', 'sections'],
  ['⏎', 'edit, or next choice'],
  ['d', 'back to the default, or remove'],
  ['a', 'add to this section'],
  ['o', 'open the file in $EDITOR'],
  ['esc', 'close'],
]

function settingKeys(row: Row | null): Hint[] {
  const hints: Hint[] = []
  if (row?.kind === 'setting') {
    if (row.edit.type === 'text') hints.push(['⏎', 'edit'])
    if (row.edit.type === 'choice') hints.push(['⏎', 'next choice'])
    if (row.isSet && row.edit.type !== 'readonly') hints.push(['d', 'default'])
  }
  if (row?.kind === 'group' && row.remove) hints.push(['d', 'remove'])
  hints.push(['a', 'add'], ['J K', 'sections'], ['o', 'open the file'], ['esc', 'close'])
  return hints
}

export const CONVERSATION_KEYS: Hint[] = [
  ['← ctrl+]', 'back to Hopper (it stays open)'],
  ['ctrl+\\', 'what it changed, in nvim'],
  ['esc', "Claude's (menus, rewind)"],
  ['ctrl+c', 'interrupt Claude'],
]

// For the help screen only.
export const MOUSE_KEYS: Hint[] = [
  ['wheel', 'scrolls what is under it'],
  ['click', 'focuses a panel'],
  ['click click', 'on a row: select, then open'],
  ['drag', 'in a conversation: copy'],
  ['modifier+drag', "copy elsewhere (your terminal's)"],
]

export const WRITING_KEYS: Hint[] = [
  ['⏎', 'new line'],
  ['ctrl+g', 'carry on in $EDITOR'],
  ['option+arrows', 'by word'],
  ['option+⌫ ctrl+w', 'delete a word'],
  ['cmd+arrows', 'to the ends'],
  ['shift', 'selects'],
  ['esc', 'save and close'],
]

// A draft's and a routine's keys, on its row in the list. The model and effort name what they
// fall back to when it picks none; for the help screen, with nothing selected, Hopper's own.
type Choices = { model?: string | undefined; effort?: string | undefined; defaults: Choice }

const QUEUE_HINT = {
  none: 'up next: when there is room',
  now: 'up next: tonight instead',
  night: 'up next: off',
}

export function draftKeys(
  e: Choices & { queue?: string | undefined; proposed?: string | undefined },
): Hint[] {
  const q = (e.queue ?? 'none') as keyof typeof QUEUE_HINT
  return [
    ['⏎', 'keep writing'],
    ['s', 'start it'],
    ['u', QUEUE_HINT[q] ?? QUEUE_HINT.none],
    ...(e.queue ? [['g', 'dispatch now'] as Hint] : []),
    ...(e.proposed ? [['U', 'queue every proposal tonight'] as Hint] : []),
    ['m', `model: ${choiceText(e.model, e.defaults.model)}`],
    ['E', `effort: ${choiceText(e.effort, e.defaults.effort)}`],
    ['w', 'move to a project'],
    ['r', 'make it a routine'],
    ['o', 'write it in $EDITOR'],
    ['y', 'copy'],
    ['e', 'throw away'],
  ]
}

export function routineKeys(e: Choices & { paused?: boolean }): Hint[] {
  return [
    ['⏎', 'open it'],
    ['M', 'mark all read'],
    ['s', 'run now'],
    ['S', 'schedule'],
    ['P', e.paused ? 'resume' : 'pause'],
    ['m', `model: ${choiceText(e.model, e.defaults.model)}`],
    ['E', `effort: ${choiceText(e.effort, e.defaults.effort)}`],
    ['w', 'project'],
    ['y', 'copy'],
    ['e', 'remove'],
  ]
}

// A routine's list in its details (⏎ on a routine): its prompt, then its reports. And one of
// them open for reading.
export const PROMPT_LINE_KEYS: Hint[] = [
  ['j k ↑↓', 'move'],
  ['⏎ →', 'edit the prompt'],
  ['o', 'edit it in $EDITOR'],
  ['M', 'mark all read'],
  ['esc ←', 'back to the list'],
]
export const REPORT_LIST_KEYS: Hint[] = [
  ['j k ↑↓', 'move'],
  ['⏎ →', 'read it'],
  ['m', 'mark read'],
  ['M', 'mark all read'],
  ['c', 'its conversation'],
  ['esc ←', 'back to the list'],
]
export const REPORT_KEYS: Hint[] = [
  ['j k ↑↓', 'scroll'],
  ['space', 'a page down'],
  ['J K', 'older, newer'],
  ['c', 'its conversation'],
  ['y', 'copy it'],
  ['esc ←', 'back to the reports'],
]
// Both, as one section of the help screen.
export const REPORTS_HELP: Hint[] = [
  ['j k ↑↓', 'move, or scroll a report'],
  ['⏎ →', 'read it, or edit the prompt'],
  ['o ctrl+g', 'the prompt in $EDITOR'],
  ['m', 'mark read'],
  ['M', 'mark all read'],
  ['space', 'a page down'],
  ['J K', 'older, newer report'],
  ['c', 'its conversation'],
  ['y', 'copy the report'],
  ['esc ←', 'back a level'],
]

// The keys that do something for what is selected right now.
export function hereKeys(h: Here): { label: string; hints: Hint[] } {
  const trust: Hint[] = h.untrusted ? [['T', 'trust the folder and start']] : []
  if (h.setting !== undefined) return { label: 'settings', hints: settingKeys(h.setting) }
  // The editor, opened from a routine's list, comes before the list it goes back to.
  if (h.editing) return { label: 'writing', hints: WRITING_KEYS }
  if (h.reports) {
    // c only when Claude still has the conversation that wrote it.
    const keep = ([k]: Hint) => k !== 'c' || h.reports!.conversation
    return h.reports.reading
      ? { label: 'a report', hints: REPORT_KEYS.filter(keep) }
      : h.reports.onPrompt
        ? { label: 'routine', hints: PROMPT_LINE_KEYS }
        : { label: 'routine reports', hints: REPORT_LIST_KEYS.filter(keep) }
  }
  if (h.focus === 'session') return { label: 'a conversation', hints: CONVERSATION_KEYS }
  if (h.focus === 'projects') {
    const hints: Hint[] = [['⏎', 'focus']]
    if (!h.row || h.row.isProject) hints.push(['tab', 'new here'])
    hints.push(['↑↓', 'move'], ['esc', 'back'])
    return { label: 'projects', hints }
  }
  if (h.focus === 'accounts') return { label: 'accounts', hints: PANEL_KEYS[3]![1] }
  const it = h.item
  const done = h.focus === 'done'
  const hints: Hint[] = []
  if (it?.kind === 'draft') hints.push(...draftKeys({ ...it, defaults: h.defaults }))
  else if (it?.kind === 'routine')
    hints.push(...routineKeys({ ...it, defaults: h.defaults, paused: it.state === 'paused' }))
  else if (it?.id) {
    if (h.embedOpen) hints.push(['⏎ →', 'into the conversation'], ['i', 'interrupt'])
    else hints.push(['⏎ →', 'open it here'])
  }
  if (it && it.kind !== 'draft' && it.kind !== 'routine')
    hints.push(['e', done ? 'bring it back' : 'archive'], ['d', 'what it changed, in nvim'])
  if (it && !done) hints.push(...holdKey(it))
  if (!done) hints.push(['J K', 'groups'])
  if (!done && h.scope) hints.push(['esc', 'every project'])
  return { label: done ? 'archived' : 'the list', hints: [...trust, ...hints] }
}

// Keys each summary on the right lists itself (panels/detail/), so the key bar leaves them out.
// h on a conversation waiting on you, or on hold; nothing on anything else.
export function holdKey(it: Item): Hint[] {
  const g = groupOf(it)
  return g === 'waiting' ? [['h', 'on hold']] : g === 'held' ? [['h', 'off hold']] : []
}

function summaryKeys(h: Here): Set<string> {
  if (h.focus === 'projects') return new Set(['⏎', 'tab'])
  if (h.focus === 'accounts') return new Set(PANEL_KEYS[3]![1].map(([k]) => k))
  if (h.item?.kind === 'routine') return new Set(routineKeys(h).flatMap(([k]) => k.split(' ')))
  if (h.item?.kind === 'draft') return new Set(draftKeys(h).flatMap(([k]) => k.split(' ')))
  if (h.item?.id) return new Set(['⏎', 'e', 'i', 'd', ...holdKey(h.item).map(([k]) => k)])
  return new Set()
}

// The key bar: the keys for where you are that nothing on screen already shows. A summary on the
// right lists its own.
export function barKeys(h: Here): Hint[] {
  const { hints } = hereKeys(h)
  if (h.editing || h.focus === 'session' || h.setting !== undefined || h.reports) return hints
  const shown = h.summaryShown ? summaryKeys(h) : new Set<string>()
  // "⏎ →" with ⏎ already on the summary is just "→".
  return hints
    .map(([k, d]): Hint => [
      k
        .split(' ')
        .filter((t) => !shown.has(t))
        .join(' '),
      d,
    ])
    .filter(([k]) => k)
}
