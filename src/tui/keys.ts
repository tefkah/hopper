import type { Key } from 'ink'

import {
  choiceText,
  defaultsFor,
  preferFirst,
  prefixesOf,
  setDefaultAccount,
  showPrefix,
  suggestName,
} from '../config.ts'
import { EFFORTS, MODELS, nextOf } from '../conversations.ts'
import { routineSessionId, type Item } from '../model.ts'
import type { Actions } from './actions.ts'
import { copyToClipboard } from './clipboard.ts'
import type { AppCtx } from './context.ts'
import { backspace, insert, move, textWidth, type EditorState, type Move } from './editor.ts'
import { keyToBytes } from './embed.ts'
import { rank } from './fuzzy.ts'
import { parseMouse, type MouseEvent } from './mouse.ts'
import { accountLines } from './panels/Accounts.tsx'
import { reportRows } from './panels/detail/RoutineDetail.tsx'
import { itemLines } from './panels/ItemRows.tsx'
import { projectLines } from './panels/ProjectRows.tsx'
import { reportMaxScroll, reportRoom } from './panes/ReportPane.tsx'
import { workItemAt } from './panes/WorkRows.tsx'
import { againKeys, asText, groupOf, typed, type Editing, type Hover, type Panel } from './state.ts'

type Handler = (input: string, key: Key) => void

export const QUIT_PROMPT = 'Press x again to quit.'

// Ink hands ctrl+g over as a g with ctrl set; the raw bell character too, in case.
const isCtrlG = (input: string, key: Key) => (key.ctrl && input === 'g') || input === '\u0007'
export const AWAKE_ON = 'Keeping this Mac awake until z again. A closed lid still sleeps it.'
export const AWAKE_OFF = 'This Mac can sleep again.'

// ctrl+\, a conversation's changes, inside it or on its row. Claude Code binds nothing to it (it
// warns it's the terminal's quit key), and Ink's raw mode keeps the terminal from making it
// SIGQUIT. It arrives as the raw control character (0x1c), or with the kitty keyboard protocol
// as ctrl and a backslash.
export const isDiffKey = (input: string, key: Key) =>
  input === '\u001c' || (key.ctrl && input === '\\')

// Every key and mouse event, by what has the keyboard: the conversation, the input line, the
// editor, Projects (which finds as you type), or the board. Built from the current context on every render.
export function makeInput(ctx: AppCtx, act: Actions): Handler {
  const { setMessage, setEditing, setForm, setSel } = ctx

  // ---- the mouse: the wheel scrolls what's under it; a click gives that panel the keyboard ----
  // In every list, the row under the pointer lights softly and a click selects it.
  // The help screen: when it is taller than the screen, j k and the arrows
  // scroll it and space a page; any other key closes it.
  const scrollHelp = (by: number) =>
    ctx.setHelp((h) => h && { scroll: Math.max(0, Math.min(ctx.helpMax, h.scroll + by)) })
  const onHelp: Handler = (input, key) => {
    if (!ctx.helpMax) return ctx.setHelp(null)
    if (input === 'j' || key.downArrow) return scrollHelp(1)
    if (input === 'k' || key.upArrow) return scrollHelp(-1)
    if (input === ' ' || key.pageDown) return scrollHelp(10)
    if (key.pageUp) return scrollHelp(-10)
    ctx.setHelp(null)
  }

  // The line of the routine's list under the pointer in its details, laid out as RoutineDetail
  // lays it out: the frame's top edge, then its lines. -1 is the prompt's line.
  const reportAt = (y: number): { routine: string; index: number } | null => {
    const it = ctx.selectedItem
    const r =
      it?.kind === 'routine'
        ? ctx.snap?.routines.find((x) => routineSessionId(x.name) === it.sessionId)
        : undefined
    if (!r || ctx.reports?.open) return null
    const { rightW, bodyH } = ctx.layout
    const project = ctx.snap?.projects.find((p) => p.key === r.project)
    const view = {
      routine: r,
      reports: ctx.routineReports,
      account: it?.account,
      now: 0,
      defaults: defaultsFor(ctx.config, project),
    }
    const { edit, top, start, slice } = reportRows(view, rightW - 4, bodyH - 2, ctx.reports?.sel)
    if (y - 2 === edit) return { routine: r.name, index: -1 }
    const line = y - 2 - top
    return line >= 0 && line < slice.length ? { routine: r.name, index: start + line } : null
  }

  const onMouse = (events: MouseEvent[]) => {
    const { leftW, midW, bandH, workH, doneH, sessionCols, sessionRows } = ctx.layout
    const { embed, pick, focus } = ctx
    for (const ev of events) {
      // Over the help screen the wheel scrolls it and nothing else does anything.
      if (ctx.help) {
        if (ev.kind === 'wheel-up' || ev.kind === 'wheel-down')
          scrollHelp(ev.kind === 'wheel-up' ? -3 : 3)
        continue
      }
      // The band (accounts beside projects) over the list over done, then the right panel.
      const panel: Panel | 'right' =
        ev.x > leftW + midW
          ? 'right'
          : ev.y <= bandH
            ? ev.x <= leftW
              ? 'accounts'
              : 'projects'
            : ev.y <= bandH + workH
              ? 'work'
              : 'done'
      // A routine's reports hand the keyboard back when the wheel or a click is anywhere else.
      if (ctx.reports && panel !== 'right' && (ev.kind === 'press' || ev.kind.startsWith('wheel')))
        ctx.setReports(null)
      // The conversation's own cells: its top edge carries the title.
      const cellAt = {
        col: Math.max(0, Math.min(sessionCols - 1, ev.x - (leftW + midW) - 2)),
        row: Math.max(0, Math.min(sessionRows - 1, ev.y - 2)),
      }
      // The row under the pointer, drawn as the lists draw it: each frame's top edge, then its
      // lines. Headings and gaps in the list aren't rows.
      const rowAt = (): Hover => {
        if (panel === 'work') {
          const i = workItemAt(ctx.work, ctx.at('work'), workH, ev.y - bandH - 2)
          return i === null ? null : { panel, index: i }
        }
        if (panel === 'done') {
          const { start, slice } = itemLines(ctx.done, ctx.at('done'), doneH)
          const line = ev.y - bandH - workH - 2
          return line >= 0 && line < slice.length ? { panel, index: start + line } : null
        }
        // The band's panels start on the first line; each has a heading line inside its frame.
        if (panel === 'projects') {
          const line = projectLines(ctx.projectRows, ctx.at('projects'), bandH)[ev.y - 2]
          return line && 'row' in line ? { panel, index: line.index } : null
        }
        if (panel !== 'accounts') return null
        const { start, slice, perAccount } = accountLines(
          ctx.accountStates,
          ctx.at('accounts'),
          bandH,
        )
        const line = Math.floor((ev.y - 3) / perAccount)
        return ev.y >= 3 && line < slice.length ? { panel, index: start + line } : null
      }
      if (ev.kind === 'move') {
        // Claude asks for every movement too, for its own hover.
        if (panel === 'right' && embed && ctx.showingEmbed)
          embed.forwardMouse('move', cellAt.col + 1, cellAt.row + 1)
        // Only a different row is a change, so the flood of movement doesn't redraw.
        const h = rowAt()
        ctx.setHover((cur) => (cur?.panel === h?.panel && cur?.index === h?.index ? cur : h))
        continue
      }
      const button = ev.kind === 'press' || ev.kind === 'drag' || ev.kind === 'release'
      if (embed && ctx.showingEmbed && button && (panel === 'right' || pick?.active)) {
        // A click in the conversation also gives it the keyboard, as a click on any panel does.
        if (ev.kind === 'press' && focus !== 'session' && !ctx.editing && !ctx.form)
          act.enter(embed, focus)
        // Claude asks for the mouse and does its own selection; give it the events.
        if (embed.mouseWanted()) {
          embed.forwardMouse(
            ev.kind as 'press' | 'drag' | 'release',
            cellAt.col + 1,
            cellAt.row + 1,
          )
          continue
        }
        // Otherwise Hopper selects: drag inside the conversation, let go to copy.
        if (ev.kind === 'press') ctx.setPick({ a: cellAt, b: cellAt, active: true })
        else if (ev.kind === 'drag' && pick?.active) ctx.setPick({ ...pick, b: cellAt })
        else if (ev.kind === 'release' && pick?.active) {
          if (cellAt.col === pick.a.col && cellAt.row === pick.a.row) ctx.setPick(null)
          else {
            const text = embed.textBetween(pick.a, cellAt)
            copyToClipboard(text)
            ctx.setPick({ a: pick.a, b: cellAt, active: false })
            setMessage(`Copied ${text.length} characters.`)
          }
        }
        continue
      }
      if (ev.kind === 'wheel-up' || ev.kind === 'wheel-down') {
        const up = ev.kind === 'wheel-up'
        if (panel === 'right') {
          const rs = ctx.reports
          if (rs?.open) {
            const max = reportMaxScroll(rs.open.text, ctx.layout.rightW, ctx.layout.bodyH)
            const scroll = Math.max(0, Math.min(max, rs.open.scroll + (up ? -3 : 3)))
            ctx.setReports({ ...rs, open: { ...rs.open, scroll } })
          } else if (rs) {
            const sel = Math.max(
              -1,
              Math.min(ctx.routineReports.length - 1, rs.sel + (up ? -1 : 1)),
            )
            ctx.setReports({ ...rs, sel })
          } else if (embed && ctx.showingEmbed) embed.wheel(up, ev.x - (leftW + midW) - 1, ev.y - 1)
          continue
        }
        // The rows move under the pointer; the next movement lights the new one.
        ctx.setHover(null)
        ctx.setEmbedShown(false)
        setSel((s) => ({
          ...s,
          [panel]: Math.max(0, Math.min(ctx.lists[panel] - 1, s[panel] + (up ? -1 : 1))),
        }))
      } else if (ev.kind === 'press' && !ctx.editing && !ctx.form) {
        const h = rowAt()
        if (h) {
          const project = h.panel === 'projects' ? ctx.projectRows[h.index] : undefined
          // A click selects the row; a second click on it, once the list has the keyboard,
          // opens it, as ⏎ would.
          if (focus === h.panel && ctx.at(h.panel) === h.index) {
            if (project) act.focusProject(project.key)
            else if (h.panel === 'accounts') {
              // Only an account that isn't signed in: signing in takes over the terminal.
              const a = ctx.accountStates[h.index]
              if (a && a.auth && !a.auth.loggedIn) void act.signIn(a.account)
            } else act.open((h.panel === 'work' ? ctx.work : ctx.done)[h.index])
          } else {
            if (ctx.at(h.panel) !== h.index) ctx.setEmbedShown(false)
            // Going to Projects starts it on its first row; the click's row comes after.
            act.go(h.panel)
            setSel((s) => ({ ...s, [h.panel]: h.index }))
          }
        } else if (panel !== 'right') act.go(panel)
        // In a routine's details a click on a report reads it, and on the prompt's line edits
        // it. The details of anything else that isn't open: a click opens it, as ⏎ would.
        else if (!ctx.showingEmbed && ctx.selectedItem) {
          const rep = reportAt(ev.y)
          if (rep?.index === -1) {
            ctx.setReports({ routine: rep.routine, sel: -1, open: null })
            act.editRoutine(ctx.selectedItem)
          } else if (rep) void act.readReport(rep.routine, rep.index)
          else if (!ctx.reports) act.open(ctx.selectedItem)
        }
      }
    }
  }

  // ---- in a conversation, every key is Claude's, esc included ----
  // Stepping back to Hopper is ← at Claude's empty prompt, or ctrl+], which works from anywhere,
  // a Claude menu included. Both leave the conversation live; ⏎ goes back in. When the screen
  // shows the empty prompt, ← steps back at once and never reaches Claude; otherwise it goes
  // through, and Claude's agents screen (embed.ts) is the fallback. Claude's interrupt is
  // ctrl+c, or i on the list. ctrl+\ opens what it changed (d on the list) and the keys stay here.
  const onSession: Handler = (input, key) => {
    const { embed } = ctx
    // ctrl+] arrives as the raw control character (0x1d).
    if (!embed || input === '\u001d' || (key.ctrl && input === ']')) return act.go(ctx.returnTo)
    if (isDiffKey(input, key))
      return void act.openChanges(ctx.snap?.items.find((i) => i.id === embed.id))
    if (key.leftArrow && !key.meta && !key.shift && !key.ctrl && embed.atEmptyPrompt())
      return act.go(ctx.returnTo)
    if (ctx.pick) ctx.setPick(null)
    embed.send(keyToBytes(input, key))
  }

  // ---- the one-line input in the key bar ----
  const onForm: Handler = (input, key) => {
    const form = ctx.form!
    if (key.escape) return setForm(null)
    if (
      form.kind === 'remove' ||
      form.kind === 'routine-remove' ||
      form.kind === 'draft-remove' ||
      form.kind === 'setting-remove'
    ) {
      // The key that asked, again, like x x.
      if (againKeys(form).includes(input)) void act.submitForm(form)
      else setForm(null)
      return
    }
    if (key.return) return void act.submitForm(form)
    if (key.backspace || key.delete) return setForm({ ...form, value: form.value.slice(0, -1) })
    if (typed(input, key)) setForm({ ...form, value: form.value + input })
  }

  // ---- the draft or routine editor ----
  const onPick = (e: Editing, input: string, key: Key) => {
    const list = rank(e.query, ctx.projectKeys)
    if (key.escape) return setEditing(null)
    if (key.upArrow) return setEditing({ ...e, pickSel: Math.max(0, e.pickSel - 1) })
    if (key.downArrow)
      return setEditing({ ...e, pickSel: Math.min(list.length - 1, e.pickSel + 1) })
    if (key.tab || key.return) {
      const chosen = list[Math.min(e.pickSel, list.length - 1)]
      if (!chosen) return setMessage('No project matches.')
      setEditing(null)
      return void act.saveEdit({ ...e, project: chosen }, `Moved to ${chosen}.`)
    }
    if (key.backspace || key.delete)
      return setEditing({ ...e, query: e.query.slice(0, -1), pickSel: 0 })
    if (typed(input, key))
      setEditing({ ...e, query: e.query + input.replace(/\s/g, ''), pickSel: 0 })
  }

  // esc saves and closes the editor; what was in it stays selected on the list, with its keys.
  const onWrite = (e: Editing, input: string, key: Key) => {
    if (key.escape) return void (e.routine ? act.keepRoutine(e) : act.keepDraft(e))
    // ctrl+g, Claude Code's own key for it: on into $EDITOR, and back here with what was written.
    if (isCtrlG(input, key)) return void act.writeOutsideHere(e)
    const ed: EditorState = { text: e.text, cursor: e.cursor, anchor: e.anchor }
    const put = (n: EditorState) => setEditing({ ...e, ...n })
    const to = (how: Move) => put(move(ed, how, textWidth(ctx.layout.rightW), key.shift))
    if (key.return) return put(insert(ed, '\n'))
    // On a Mac, Backspace arrives as delete; Option+Backspace removes a word.
    if (key.backspace || key.delete) return put(backspace(ed, key.meta))
    // Terminal.app without "Use Option as Meta key" sends Option+Backspace as a plain delete.
    if (key.ctrl && input === 'w') return put(backspace(ed, true))
    if (key.leftArrow) return to(key.meta ? 'wordLeft' : key.ctrl ? 'home' : 'left')
    if (key.rightArrow) return to(key.meta ? 'wordRight' : key.ctrl ? 'end' : 'right')
    if (key.upArrow) return to(key.meta ? 'top' : 'up')
    if (key.downArrow) return to(key.meta ? 'bottom' : 'down')
    if (key.home) return to('home')
    if (key.end) return to('end')
    // What Mac terminals send for Option+←/→ and Cmd+←/→ by default.
    if (key.meta && (input === 'b' || input === 'f'))
      return to(input === 'b' ? 'wordLeft' : 'wordRight')
    if (key.ctrl && (input === 'a' || input === 'e')) return to(input === 'a' ? 'home' : 'end')
    if (typed(input, key)) put(insert(ed, asText(input)))
  }

  const onEditing: Handler = (input, key) => {
    const e = ctx.editing!
    if (e.stage === 'pick') return onPick(e, input, key)
    onWrite(e, input, key)
  }

  // ---- Projects: typing finds, ⏎ narrows the list to the one found, tab starts one there ----
  const onProjects: Handler = (input, key) => {
    const row = ctx.selectedRow
    // → as well as esc: the list is the column to the right.
    if (key.escape || key.rightArrow) return act.go('work')
    if (key.return) return row ? act.focusProject(row.key) : setMessage('No project matches.')
    if (key.tab) {
      if (!row) return setMessage('No project matches.')
      if (!row.isProject) return setMessage(`${row.key} is a folder. Pick a project in it.`)
      return act.newConversation(row.key)
    }
    if (key.upArrow || key.downArrow) {
      ctx.setEmbedShown(false)
      const to = ctx.at('projects') + (key.downArrow ? 1 : -1)
      return setSel((s) => ({ ...s, projects: Math.max(0, Math.min(ctx.lists.projects - 1, to)) }))
    }
    const find = (query: string) => {
      ctx.setQuery(query)
      setSel((s) => ({ ...s, projects: 0 }))
    }
    if (key.backspace || key.delete) return find(ctx.query.slice(0, -1))
    if (typed(input, key)) find(ctx.query + input.replace(/\s/g, ''))
  }

  // ---- the settings screen ----
  const onSettings: Handler = (input, key) => {
    const rows = ctx.settingRows
    const sel = Math.min(ctx.settings!.sel, Math.max(0, rows.length - 1))
    const row = rows[sel]
    const to = (i: number) => ctx.setSettings({ sel: Math.max(0, Math.min(rows.length - 1, i)) })
    const section = (from: number, d: 1 | -1) => {
      let i = from + d
      while (i >= 0 && i < rows.length && rows[i]!.kind !== 'section') i += d
      return i
    }
    if (key.escape) return ctx.setSettings(null)
    if (input === 'J' || (key.shift && key.downArrow)) return to(section(sel, 1))
    if (input === 'K' || (key.shift && key.upArrow))
      return to(section(sel + 1, -1) === sel ? section(sel, -1) : section(sel + 1, -1))
    if (input === 'j' || key.downArrow) return to(sel + 1)
    if (input === 'k' || key.upArrow) return to(sel - 1)
    if (!row) return
    if (key.return) return act.settingsEdit(row)
    if (input === 'd') return act.settingsReset(row)
    if (input === 'o') return void act.settingsOpenFile(row.file)
    if (input === 'a') {
      const at = rows[section(sel + 1, -1)]
      if (at?.kind === 'section') return act.settingsAdd(at)
    }
    if (input === 'x') return ctx.message === QUIT_PROMPT ? ctx.exit() : setMessage(QUIT_PROMPT)
  }

  // ---- a routine's list, in its details: the prompt, then its reports ----
  // The list: j k and the arrows move, ⏎ or → edits the prompt or reads a report, o edits the
  // prompt in $EDITOR; m marks the
  // selected report read, M all of them. Reading: they scroll, J K go to the next older and
  // newer report. esc or ← goes back a level each time; c opens the conversation that wrote the
  // report, while Claude still has it.
  const onReports: Handler = (input, key) => {
    const rs = ctx.reports!
    const list = ctx.routineReports
    const last = list.length - 1
    const rep = list[rs.sel]
    if (input === 'c' && rep) return act.reportConversation(rep)
    if (input === '?') return ctx.setHelp({ scroll: 0 })
    if (input === 'M') return void act.markAllReports(rs.routine)
    const open = rs.open
    if (!open) {
      if (key.escape || key.leftArrow) return ctx.setReports(null)
      if (input === 'j' || key.downArrow)
        return ctx.setReports({ ...rs, sel: Math.min(last, rs.sel + 1) })
      if (input === 'k' || key.upArrow)
        return ctx.setReports({ ...rs, sel: Math.max(-1, rs.sel - 1) })
      if (key.return || key.rightArrow)
        return rep ? void act.readReport(rs.routine, rs.sel) : act.editRoutine(ctx.selectedItem)
      if ((input === 'o' || isCtrlG(input, key)) && rs.sel === -1) {
        const e = act.editingOf(ctx.selectedItem)
        return e ? void act.writeOutside(e) : undefined
      }
      if (input === 'm' && rep) {
        if (!rep.unread) return setMessage('Already read.')
        return void act.markReportsRead(rs.routine, [rep])
      }
      return
    }
    const { rightW, bodyH } = ctx.layout
    const max = reportMaxScroll(open.text, rightW, bodyH)
    const page = Math.max(1, reportRoom(bodyH) - 2)
    const scroll = (by: number) =>
      ctx.setReports({
        ...rs,
        open: { ...open, scroll: Math.max(0, Math.min(max, open.scroll + by)) },
      })
    if (key.escape || key.leftArrow) return ctx.setReports({ ...rs, open: null })
    if (input === 'J' || (key.shift && key.downArrow))
      return void act.readReport(rs.routine, Math.min(last, rs.sel + 1))
    if (input === 'K' || (key.shift && key.upArrow))
      return void act.readReport(rs.routine, Math.max(0, rs.sel - 1))
    if (input === 'j' || key.downArrow) return scroll(1)
    if (input === 'k' || key.upArrow) return scroll(-1)
    if (input === ' ' || key.pageDown) return scroll(page)
    if (key.pageUp) return scroll(-page)
    if (input === 'y') {
      copyToClipboard(open.text)
      return setMessage('Report copied.')
    }
  }

  // ---- the board: panels, lists and accounts ----
  // A draft's and a routine's keys work on its row, without opening it: ⏎ is the only way into
  // the editor. They come before the board's letters, so none of them may be a jump (p c v a).
  const rowKeys = (it: Item | undefined): Record<string, () => unknown> => {
    const e = act.editingOf(it)
    if (!it || !e) return {}
    const r = e.routine
    const d = defaultsFor(
      ctx.config,
      ctx.snap?.projects.find((p) => p.key === e.project),
    )
    const both: Record<string, () => unknown> = {
      s: () => (r ? act.runNow(e) : act.start(e)),
      m: () => {
        const model = nextOf(MODELS, e.model)
        return act.saveEdit({ ...e, model }, `Model: ${choiceText(model, d.model)}.`)
      },
      E: () => {
        const effort = nextOf(EFFORTS, e.effort)
        return act.saveEdit({ ...e, effort }, `Effort: ${choiceText(effort, d.effort)}.`)
      },
      w: () => setEditing({ ...e, stage: 'pick', query: '', pickSel: 0 }),
      y: () => {
        copyToClipboard(e.text)
        setMessage(r ? 'Prompt copied.' : 'Draft copied.')
      },
    }
    if (r) {
      return {
        ...both,
        S: () => setForm({ kind: 'routine-schedule', value: r.schedule, editing: e, name: r.name }),
        P: () => {
          const enabled = !r.enabled
          const said = `${enabled ? 'Resumed' : 'Paused'} ${r.name}.`
          return act.saveEdit({ ...e, routine: { ...r, enabled } }, said)
        },
        M: () => act.markAllReports(r.name),
        e: () => setForm({ kind: 'routine-remove', name: r.name }),
      }
    }
    return {
      ...both,
      r: () => {
        if (!e.text.trim()) return setMessage('Prompt is empty.')
        const suggested = (e.text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
          .slice(0, 3)
          .join('-')
          .slice(0, 30)
        setForm({ kind: 'routine-name', value: suggested, editing: e })
      },
      e: () => setForm({ kind: 'draft-remove', id: e.id, name: it.name }),
      o: () => act.writeOutside(e),
      // Up next: off, then as soon as there's room, then tonight.
      u: () => {
        const q = e.extra?.queue
        return act.setQueue(e, q === undefined ? 'now' : q === 'now' ? 'night' : undefined)
      },
      U: () => act.queueProposed(),
    }
  }

  const onList = (panel: 'work' | 'done', input: string, key: Key) => {
    const list = panel === 'work' ? ctx.work : ctx.done
    const it = list[ctx.at(panel)]
    if (input === 'i') {
      if (!ctx.embed || ctx.embed.id !== it?.id) return setMessage('Open it first (⏎).')
      ctx.embed.send('\x1b')
      return setMessage('Sent esc to Claude.')
    }
    if (key.return) return act.open(it)
    // e archives, as in Gmail, and in Archived brings it back.
    if (input === 'e') return void act.markDone(it, panel === 'work')
    if (input === 'h' && panel === 'work') return void act.hold(it)
    if (input === 'd' || isDiffKey(input, key)) return void act.openChanges(it)
    if (input === 'g') return void act.dispatchNow()
  }

  const onAccounts = (input: string, key: Key) => {
    const { config } = ctx
    const a = ctx.accountStates[ctx.at('accounts')]?.account
    if (input === 'a') {
      const hint = ctx.snap?.accounts.find((s) => s.account.configDir === null)?.auth ?? null
      return setForm({
        kind: 'add-name',
        value: config.accounts.length ? '' : suggestName(hint, []),
      })
    }
    if (!a) return
    if (key.return) return void act.signIn(a)
    if (input === 'e') {
      const current = prefixesOf(config, a.name)
        .map((r) => showPrefix(r.prefix))
        .join(', ')
      return setForm({ kind: 'prefixes', name: a.name, value: current })
    }
    if (input === 'r') return setForm({ kind: 'label', name: a.name, value: a.label })
    if (input === '1')
      return void act.commit((c) => preferFirst(c, a.name), `${a.name} is first on its routes`)
    if (input === '*') {
      return void act.commit(
        (c) => setDefaultAccount(c, a.name),
        `${a.name} is the default: it runs anything no route names`,
      )
    }
    if (input === 'u') {
      setMessage(`Fetching ${a.name} usage…`)
      return void ctx.askUsage(a)
    }
    if (input === 'd') return setForm({ kind: 'remove', name: a.name })
  }

  const onBoard: Handler = (input, key) => {
    const focus = ctx.focus as Panel
    if (focus === 'projects') return onProjects(input, key)
    // ctrl+g is o on a draft, and nothing anywhere else on the board: never the g it arrives as.
    if (isCtrlG(input, key)) {
      const e = focus === 'work' || focus === 'done' ? act.editingOf(ctx.selectedItem) : undefined
      return e && !e.routine ? void act.writeOutside(e) : undefined
    }
    const own = focus === 'work' || focus === 'done' ? rowKeys(ctx.selectedItem)[input] : undefined
    if (own) return void own()
    // esc comes back to the list, then shows every project again. It never goes up to Projects.
    if (key.escape) {
      if (focus !== 'work') return act.go('work')
      if (ctx.scope) ctx.setScope(null)
      return
    }
    if (key.tab) return act.newConversation()
    const jump: Record<string, Panel> = { p: 'projects', c: 'work', v: 'done', a: 'accounts' }
    // In Accounts, a is its own key again: add an account.
    if (jump[input] && !(input === 'a' && focus === 'accounts')) return act.go(jump[input])
    if (input === 'n') {
      // Straight to the first thing waiting on me, below running. On hold doesn't count.
      act.go('work')
      const first = ctx.work.findIndex((w) => groupOf(w) === 'waiting')
      if (first < 0) return setMessage('Nothing waiting on you.')
      return setSel((s) => ({ ...s, work: first }))
    }
    if (input === '?') return ctx.setHelp({ scroll: 0 })
    if (input === ',') return ctx.setSettings({ sel: 0 })
    if (input === 'z' && ctx.toggleAwake) {
      ctx.toggleAwake()
      return setMessage(ctx.awake ? AWAKE_OFF : AWAKE_ON)
    }
    // Quitting takes a second x straight after, so a stray one never closes Hopper.
    if (input === 'x') return ctx.message === QUIT_PROMPT ? ctx.exit() : setMessage(QUIT_PROMPT)
    if (input === 'R') return void ctx.refresh(true)
    if (input === 'T' && ctx.untrusted) return void act.trust()

    // → and ← are between the list and the conversation on the right: on the list → is ⏎, it
    // opens what's selected (or goes back into it), and ← at Claude's empty prompt comes back.
    // ← on the list does nothing; Projects is p.
    if (key.rightArrow) {
      if (focus === 'accounts') return act.go('work')
      if (focus === 'work' || focus === 'done') {
        const it = (focus === 'work' ? ctx.work : ctx.done)[ctx.at(focus)]
        if (it) return act.open(it)
        if (ctx.embed) act.enter(ctx.embed, focus)
      }
      return
    }
    if (key.leftArrow) return
    const step = (d: number) => {
      ctx.setEmbedShown(false)
      setSel((s) => ({
        ...s,
        [focus]: Math.max(0, Math.min(ctx.lists[focus] - 1, ctx.at(focus) + d)),
      }))
    }
    // shift+↑↓ (or J K) jump to the list's next group.
    const jumpTo = (d: 1 | -1) => {
      if (focus !== 'work') return
      const from = ctx.at(focus)
      const marks = ctx.work.map((w, i) => i === 0 || groupOf(w) !== groupOf(ctx.work[i - 1]!))
      let i = from + d
      while (i >= 0 && i < marks.length && !marks[i]) i += d
      if (i < 0 || i >= marks.length) return
      ctx.setEmbedShown(false)
      setSel((s) => ({ ...s, [focus]: i }))
    }
    if (input === 'J' || (key.shift && key.downArrow)) return jumpTo(1)
    if (input === 'K' || (key.shift && key.upArrow)) return jumpTo(-1)
    if (input === 'j' || key.downArrow) return step(1)
    if (input === 'k' || key.upArrow) return step(-1)

    if (focus === 'work' || focus === 'done') return onList(focus, input, key)
    onAccounts(input, key)
  }

  return (input, key) => {
    // Mouse events arrive as text; they are never keys, whatever has focus.
    const mouse = parseMouse(input)
    if (mouse) return onMouse(mouse)
    if (ctx.focus === 'session') return onSession(input, key)
    if (key.ctrl && input === 'c') return ctx.exit()
    // A message stays until the next keypress, then the key hints come back.
    if (ctx.message && !ctx.editing) setMessage(null)
    if (ctx.help) return onHelp(input, key)
    if (ctx.form) return onForm(input, key)
    if (ctx.settings) return onSettings(input, key)
    if (ctx.editing) return onEditing(input, key)
    if (ctx.reports) return onReports(input, key)
    onBoard(input, key)
  }
}
