import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runInteractive, UntrustedError } from '../claude.ts'
import { dispatchOnce } from '../commands.ts'
import {
  addAccount,
  ConfigError,
  parsePrefixList,
  relabel,
  removeAccount,
  setPrefixes,
  type Account,
  type Config,
} from '../config.ts'
import { setDone } from '../done.ts'
import { deleteDraft, newDraftId, saveDraft, setDraftText, type Draft } from '../drafts.ts'
import { when } from '../format.ts'
import { readIfThere } from '../fsutil.ts'
import { setHeld } from '../held.ts'
import { draftSessionId, routineSessionId, withDone, type Item } from '../model.ts'
import { inGhostty, openChanges as openChangesIn } from '../nvim.ts'
import { expandHome, isWithin, tildify } from '../paths.ts'
import { hopperPrompt } from '../prompts.ts'
import {
  deleteRoutine,
  nextRun,
  ROUTINE_NAME,
  runRoutine,
  saveRoutine,
  setRoutinePrompt,
  type Report,
  type Routine,
} from '../routines/index.ts'
import { pickAccount } from '../routing.ts'
import { markAllRead, markRead } from '../seen.ts'
import { startDraft } from '../start.ts'
import { findTranscript } from '../transcript.ts'
import { copyToClipboard } from './clipboard.ts'
import type { AppCtx } from './context.ts'
import { admit, EmbeddedSession } from './embed.ts'
import { editorName, editText, runInTerminal } from './external.ts'
import { MOUSE_OFF, MOUSE_ON } from './mouse.ts'
import { makeSettingsActions } from './settingsActions.ts'
import {
  groupOf,
  newEditing,
  now,
  toDraft,
  toRoutine,
  type Editing,
  type Focus,
  type Form,
  type Panel,
} from './state.ts'

const whenNext = (schedule: string) => {
  const n = nextRun(schedule, new Date())
  return n ? `next ${when(n.getTime())}` : 'run-now only'
}

// Trusting Hopper's home once covers every meta/ project inside it.
const trustDir = (config: Config, dir: string) => (isWithin(dir, config.home) ? config.home : dir)

// Everything the app does in response to a key: starting conversations, opening them, saving
// drafts and routines, account edits. Built from the current context on every render.
export function makeActions(ctx: AppCtx) {
  const { config, snap, refresh, setMessage, setEditing, setForm, setSel } = ctx

  const go = (f: Focus) => {
    // Projects starts afresh each time you go to it: nothing typed, on its first row.
    if (f === 'projects' && ctx.focus !== 'projects') {
      ctx.setQuery('')
      setSel((s) => ({ ...s, projects: 0 }))
    }
    ctx.setFocus(f)
    setMessage(null)
  }

  const focusProject = (key: string) => {
    ctx.setScope(key)
    setSel((s) => ({ ...s, work: 0, done: 0 }))
    go('work')
  }

  // Where a new conversation goes: the project it's asked for (from Projects), else the scope,
  // else the inbox. Closing the editor comes back to the list.
  const newConversation = (at?: string) => {
    if (ctx.focus === 'projects') go('work')
    const key = at ?? ctx.scopeProject ?? 'meta/inbox'
    const project = snap?.projects.find((p) => p.key === key)
    write(
      newEditing({
        id: newDraftId(),
        project: key,
        text: '',
        created: now(),
        model: project?.model,
        effort: project?.effort,
      }),
      true,
    )
  }

  const draftEditing = (d: Draft) =>
    newEditing({
      id: d.id,
      project: d.project,
      text: d.text,
      created: d.created,
      model: d.model,
      effort: d.effort,
      extra: {
        ...(d.queue ? { queue: d.queue } : {}),
        ...(d.after ? { after: d.after } : {}),
        ...(d.done ? { done: d.done } : {}),
        ...(d.proposed ? { proposed: d.proposed } : {}),
        ...(d.depth ? { depth: d.depth } : {}),
      },
    })

  const routineEditing = (r: Routine) =>
    newEditing({
      id: 'routine:' + r.name,
      project: r.project,
      text: r.prompt,
      created: now(),
      model: r.model,
      effort: r.effort,
      routine: {
        name: r.name,
        schedule: r.schedule,
        enabled: r.enabled,
        ...(r.check ? { check: r.check } : {}),
      },
    })

  // A draft or routine on the list, as the editor would hold it, so the list's keys act on it the
  // way they would with it open.
  const editingOf = (item: Item | undefined): Editing | undefined => {
    if (item?.kind === 'draft') {
      const d = snap?.drafts.find((x) => draftSessionId(x.id) === item.sessionId)
      return d && draftEditing(d)
    }
    if (item?.kind === 'routine') {
      const r = snap?.routines.find((x) => routineSessionId(x.name) === item.sessionId)
      return r && routineEditing(r)
    }
    return undefined
  }

  // Closing the editor leaves what was in it selected on the list, with its details on the
  // right. The list catches up on the next refresh; App selects the row once it is there.
  const leaveEditor = (sessionId: string) => {
    setEditing(null)
    ctx.setFollow(sessionId)
    ctx.setEmbedShown(false)
    ctx.setFocus('work')
  }

  const keepDraft = async (e: Editing) => {
    if (!e.text.trim()) {
      setEditing(null)
      return setMessage('Empty, so not kept.')
    }
    leaveEditor(draftSessionId(e.id))
    await saveDraft(config.home, toDraft(e, now()))
    void refresh(false)
  }

  // Writing in the person's own editor ($VISUAL, $EDITOR), with Hopper suspended. Only the text
  // goes to it, and it comes back into the file as the file is by then, so nothing else in it
  // changes. `fresh` is a draft not saved yet (tab): it's kept only if something was written.
  const fromEditor = async (e: Editing): Promise<string | null> => {
    try {
      const text = await editText(ctx.suspendTerminal, e.text, e.routine?.name ?? `draft-${e.id}`)
      if (text === null) setMessage(`${editorName()} quit with an error: nothing changed.`)
      return text
    } catch (err) {
      setMessage(`Couldn't open ${editorName()}: ${(err as Error).message}`)
      return null
    }
  }

  const writeOutside = async (e: Editing, fresh = false) => {
    const r = e.routine
    const text = await fromEditor(e)
    if (text === null) return
    if (!text.trim())
      return setMessage(fresh ? 'Empty, so not kept.' : 'Empty, so nothing changed.')
    if (!fresh && text === e.text.replace(/\s+$/, '')) return setMessage('No change.')
    try {
      if (r) {
        const saved = await setRoutinePrompt(config.home, r.name, text)
        if (saved)
          ctx.patch((s) => ({
            ...s,
            routines: s.routines.map((x) => (x.name === r.name ? saved : x)),
          }))
        // Removed meanwhile, from another window: what was written brings it back.
        else
          await saveRoutine(config.home, toRoutine({ ...e, text }, r.name, r.schedule, r.enabled))
        setMessage(`Saved ${r.name}'s prompt.`)
      } else if (fresh) {
        await saveDraft(config.home, toDraft({ ...e, text }, now()))
        leaveEditor(draftSessionId(e.id))
        setMessage('Draft kept.')
      } else {
        const saved = await setDraftText(config.home, e.id, text, now())
        // The list's keys act on the snapshot's copy: it has the new text before any load does.
        if (saved) {
          ctx.patch((s) => ({ ...s, drafts: s.drafts.map((d) => (d.id === saved.id ? saved : d)) }))
          setMessage('Draft saved.')
        } else {
          // Started or thrown away meanwhile (a queued one can start while you write): what
          // was written is kept as a draft of its own.
          const id = newDraftId()
          await saveDraft(config.home, toDraft({ ...e, id, text, extra: undefined }, now()))
          ctx.setFollow(draftSessionId(id))
          setMessage('It started or went while you wrote, so what you wrote is a new draft.')
        }
      }
    } catch (err) {
      setMessage(`Not saved: ${(err as Error).message}`)
    }
    await refresh(false)
  }

  // ctrl+g while writing, as in Claude Code: what's typed so far goes to the person's editor and
  // comes back into Hopper's, the cursor at the end. A draft is saved first, so nothing typed is
  // lost while the editor has it; a routine still saves on esc.
  const writeOutsideHere = async (e: Editing) => {
    if (!e.routine && e.text.trim()) await saveDraft(config.home, toDraft(e, now()))
    const text = await fromEditor(e)
    if (text === null) return
    setEditing((cur) =>
      cur?.id === e.id ? { ...cur, text, cursor: text.length, anchor: null } : cur,
    )
  }

  // Where tab, and ⏎ on a draft or a routine's prompt, write: Hopper's editor, or the person's.
  const write = (e: Editing, fresh = false) =>
    config.draftEditor === 'external' ? void writeOutside(e, fresh) : setEditing(e)

  // Goes into an open conversation: it moves to the front of the open ones and gets the keyboard.
  const enter = (session: EmbeddedSession, from: Panel) => {
    ctx.setEmbeds((cur) => admit(cur, session).open)
    ctx.setEmbedShown(true)
    ctx.setReturnTo(from)
    ctx.setFocus('session')
  }

  // Opens a conversation in the right-hand panel and gives it the keyboard, keeping the others
  // open up to the cap. Attach runs in the conversation's own folder: Claude's agents view opens
  // wherever attach runs, and that folder is one Claude already trusts.
  const openEmbedded = (
    account: Account,
    id: string,
    name: string,
    from: Panel,
    cwd: string,
    key?: string,
  ) => {
    // A conversation whose folder has gone (a worktree removed after it finished) attaches from
    // its project's run folder instead; in its own missing folder attach exits at once.
    const project = snap?.projects.find((p) => p.key === key)
    const dir = existsSync(cwd) ? cwd : (project?.runIn ?? config.home)
    const opened = now()
    const { sessionCols, sessionRows } = ctx.layout
    const session = new EmbeddedSession(account, id, name, sessionCols, sessionRows, {
      onCopy: (text) => {
        copyToClipboard(text)
        setMessage(`Copied ${text.length} characters.`)
      },
      // The attach ended. Only the conversation you were in takes the keyboard back with it; one
      // open behind it just drops out of the open ones, back to its summary.
      onLeave: () => {
        const inFront = ctx.embedsRef.current[0] === session
        ctx.setEmbeds((cur) => cur.filter((e) => e !== session))
        if (inFront) {
          ctx.setEmbedShown(false)
          ctx.setFocus((f) => (f === 'session' ? from : f))
        }
        // Gone again within a second or two: it never opened, so say so rather than flicker.
        if (now() - opened < 2000) setMessage(`Couldn't open ${name}: claude attach ended at once.`)
        else if (inFront) setMessage(null)
        void refresh(false)
      },
      onStepBack: () => {
        ctx.setFocus(from)
        setMessage(null)
      },
    })
    session.start(dir)
    const { dropped } = admit(ctx.embedsRef.current, session)
    for (const d of dropped) d.close()
    enter(session, from)
  }

  // Starting hands the draft to Claude Code as a background session in the project's folder. It
  // isn't opened: starting takes a moment, and by then you're often elsewhere, maybe starting the
  // next one. It shows in the list as running; ⏎ on it opens it.
  const start = async (e: Editing) => {
    const text = e.text.trim()
    if (!text) return setMessage('Draft is empty.')
    const project = snap?.projects.find((p) => p.key === e.project)
    if (!project) return setMessage(`No project ${e.project}.`)
    const pick = pickAccount(config, project.key, snap?.accounts ?? [])
    if (!pick.account) return setMessage(`Can't start: ${pick.reason}.`)
    const account = pick.account
    const draft = toDraft(e, now())
    await saveDraft(config.home, draft)
    setEditing(null)
    setMessage(`Starting on ${account.name}${e.model ? ' with ' + e.model : ''}…`)
    try {
      const { name } = await startDraft({ config, project, account, draft, unattended: false })
      await refresh(false)
      setMessage(`Started on ${account.name}: ${name}`)
    } catch (err) {
      if (err instanceof UntrustedError) {
        const dir = trustDir(config, err.dir)
        ctx.setUntrusted({ dir, draft: e })
        setMessage(`Untrusted folder. T trusts it and starts: ${tildify(dir)}`)
      } else setMessage(`${(err as Error).message}. Draft kept.`)
      void refresh(false)
    }
  }

  // Opens Claude interactively in the folder so its trust prompt can be accepted, then starts.
  const trust = async () => {
    const u = ctx.untrusted
    if (!u) return
    const pick = pickAccount(config, u.draft.project, snap?.accounts ?? [])
    if (!pick.account) return setMessage(`Can't start: ${pick.reason}.`)
    const account = pick.account
    await ctx.suspendTerminal(async () => {
      process.stdout.write(MOUSE_OFF)
      process.stdout.write(
        `\nAccept Claude's trust prompt for ${tildify(u.dir)}, then type /exit to come back to Hopper.\n\n`,
      )
      await runInteractive(account, [], u.dir)
      process.stdout.write(MOUSE_ON)
    })
    ctx.setUntrusted(null)
    await start(u.draft)
  }

  const markDone = async (item: Item | undefined, done: boolean) => {
    if (!item) return
    try {
      await setDone(config.home, item.sessionId, done)
    } catch (e) {
      return setMessage(`Couldn't mark it: ${(e as Error).message}`)
    }
    // It moves now; the load after, which asks every account's claude, catches up behind it.
    ctx.patch((s) => withDone(s, item.sessionId, done))
    setMessage(done ? `Archived: ${item.name}` : `Back in Conversations: ${item.name}`)
    void refresh(false)
  }

  // h on a conversation waiting on me: on hold, or off it. Only those wait; a reply ends a hold
  // by itself (model.ts), so this is the only way on.
  const hold = async (item: Item | undefined) => {
    if (!item) return
    const g = groupOf(item)
    if (g !== 'waiting' && g !== 'held')
      return setMessage('Only a conversation waiting on you goes on hold.')
    const on = g === 'waiting'
    try {
      await setHeld(config.home, item.sessionId, on)
    } catch (e) {
      return setMessage(`Couldn't hold it: ${(e as Error).message}`)
    }
    setMessage(on ? `On hold: ${item.name}` : `Back in waiting on you: ${item.name}`)
    await refresh(false)
  }

  // d on a conversation, or ctrl+\ in one: what it changed, in nvim (nvim.ts says where).
  const openChanges = async (item: Item | undefined) => {
    if (!item || (item.kind !== 'background' && item.kind !== 'interactive'))
      return setMessage('Only a conversation has changes to show.')
    const account = config.accounts.find((a) => a.name === item.account)
    setMessage('Looking at what it changed…')
    const said = await openChangesIn({
      transcript: account
        ? await findTranscript(account.configDir, item.cwd, item.sessionId)
        : null,
      cwd: item.cwd,
      template: config.diffCommand,
      server: config.nvimServer,
      ghostty: inGhostty(),
      sides: join(tmpdir(), 'hopper-changes', item.sessionId),
      here: async (nvim, args, dir) => {
        await runInTerminal(ctx.suspendTerminal, nvim, args, { cwd: dir })
      },
    })
    setMessage(said)
  }

  // ⏎ on anything in the lists. A routine's goes into its details (enterRoutine).
  const open = (item: Item | undefined) => {
    if (!item) return
    if (item.kind === 'routine') {
      const r = snap?.routines.find((x) => routineSessionId(x.name) === item.sessionId)
      return r ? enterRoutine(r.name) : undefined
    }
    if (item.kind === 'draft') {
      const e = editingOf(item)
      return e ? write(e) : undefined
    }
    const account = config.accounts.find((a) => a.name === item.account)
    if (!item.id || !account) return setMessage('Interactive session: switch to its terminal.')
    // Already open: just go back in.
    const already = ctx.embeds.find((e) => e.id === item.id)
    if (already) return enter(already, ctx.listFocus)
    openEmbedded(account, item.id, item.name, ctx.listFocus, item.cwd, item.key)
  }

  // ⏎ on a routine: the list in its details (edit the prompt, then its reports) takes the
  // keyboard, on the newest unread report, else the newest, else the prompt.
  const enterRoutine = (name: string) => {
    const list = ctx.routineReports
    const unread = list.findIndex((r) => r.unread)
    ctx.setEmbedShown(false)
    ctx.setReports({ routine: name, sel: unread >= 0 ? unread : list.length ? 0 : -1, open: null })
  }

  // The routine's prompt, from the top of that list. Closing the editor comes back to the list.
  const editRoutine = (item: Item | undefined) => {
    const e = editingOf(item)
    if (e) write(e)
  }

  const markReportsRead = async (routine: string, which: Report[] | 'all') => {
    const list = ctx.routineReports
    if (which === 'all') await markAllRead(config.home, routine, list)
    else
      await markRead(
        config.home,
        routine,
        which.map((r) => r.path),
        list,
      )
    await refresh(false)
  }

  // M: every report the routine has now, read.
  const markAllReports = (routine: string) => {
    if (!ctx.routineReports.some((r) => r.unread)) return setMessage('Nothing unread.')
    setMessage(`Marked ${routine}'s reports read.`)
    return markReportsRead(routine, 'all')
  }

  // Opens one of the routine's reports for reading, in place of the list.
  const readReport = async (routine: string, i: number) => {
    const rep = ctx.routineReports[i]
    if (!rep) return
    const text = await readIfThere(rep.path).catch(() => null)
    if (text === null) return setMessage('That report is gone.')
    ctx.setEmbedShown(false)
    ctx.setReports({ routine, sel: i, open: { path: rep.path, text, scroll: 0 } })
    if (rep.unread) void markReportsRead(routine, [rep])
  }

  // The conversation that wrote a report, while Claude still has it.
  const reportConversation = (rep: Report | undefined) => {
    const item = rep?.id ? snap?.items.find((i) => i.id === rep.id) : undefined
    if (!item)
      return setMessage(rep?.id ? 'Its conversation is gone.' : 'No conversation Hopper knows of.')
    ctx.setReports(null)
    open(item)
  }

  // Routines: saved on esc. The open app runs them when they're due (autopilot.ts).
  const saveAndSync = async (r: Routine) => {
    await saveRoutine(config.home, r)
    void refresh(false)
  }

  const keepRoutine = async (e: Editing) => {
    const r = e.routine
    if (!r) return
    leaveEditor(routineSessionId(r.name))
    try {
      await saveAndSync(toRoutine(e, r.name, r.schedule, r.enabled))
      setMessage(`Saved ${r.name} · ${r.enabled ? whenNext(r.schedule) : 'paused'}`)
    } catch (err) {
      setMessage((err as Error).message)
    }
  }

  // A change made from the list (model, effort, project, paused): saved straight away.
  const saveEdit = async (e: Editing, done: string) => {
    try {
      const r = e.routine
      if (r) await saveAndSync(toRoutine(e, r.name, r.schedule, r.enabled))
      else {
        await saveDraft(config.home, toDraft(e, now()))
        void refresh(false)
      }
      setMessage(done)
    } catch (err) {
      setMessage((err as Error).message)
    }
  }

  // Run now: the testing loop. Saves the prompt and runs it; like a started draft, the run shows
  // in the list rather than opening.
  const runNow = async (e: Editing) => {
    if (!e.routine) return
    const r = toRoutine(e, e.routine.name, e.routine.schedule, e.routine.enabled)
    setEditing(null)
    try {
      await saveAndSync(r)
      const out = await runRoutine({
        config,
        routine: r,
        projects: snap?.projects ?? [],
        accounts: snap?.accounts ?? [],
        sessions: snap?.items ?? [],
        systemPrompt: hopperPrompt,
      })
      if (out.status === 'skipped') return setMessage(`Skipped ${r.name}: ${out.reason}.`)
      if (out.status === 'passed') {
        await refresh(false)
        return setMessage(`${r.name}: the check passed, so nothing to run.`)
      }
      await refresh(false)
      setMessage(`Running ${r.name} on ${out.account}.`)
    } catch (err) {
      if (err instanceof UntrustedError) {
        setMessage(
          `Untrusted folder. Start a conversation there (tab) to trust it: ${tildify(trustDir(config, err.dir))}`,
        )
      } else setMessage((err as Error).message)
    }
  }

  // Every account edit is saved at once; a bad one leaves the old config and says why.
  const commit = async (edit: (c: Config) => Config, done?: string) => {
    try {
      const next = edit(config)
      await ctx.save(next)
      ctx.setConfig(next)
      if (done) setMessage(done)
      return next
    } catch (e) {
      setMessage(e instanceof ConfigError ? e.message : `Could not save: ${(e as Error).message}`)
      return null
    }
  }

  const signIn = async (account: Account) => {
    await ctx.suspendTerminal(async () => {
      process.stdout.write(MOUSE_OFF)
      if (account.configDir) await mkdir(account.configDir, { recursive: true })
      process.stdout.write(`\nSigning in ${account.name} (${account.label})…\n\n`)
      await runInteractive(account, ['auth', 'login'])
      process.stdout.write(MOUSE_ON)
    })
    await refresh(true)
    // A new account starts labelled with its short name; take the org's name once we know it.
    const auth = ctx.snapRef.current?.accounts.find((s) => s.account.name === account.name)?.auth
    if (auth?.loggedIn && account.label === account.name && (auth.orgName || auth.email)) {
      await commit((c) => relabel(c, account.name, auth.orgName ?? auth.email ?? account.name))
    }
    setMessage(
      auth?.loggedIn ? `${account.name} is signed in` : `${account.name} is still signed out`,
    )
  }

  const submitRoutineForm = async (f: Form) => {
    if (f.kind === 'routine-name') {
      const name = f.value.trim()
      if (!ROUTINE_NAME.test(name)) return setMessage('Use lowercase letters, digits and hyphens.')
      if (snap?.routines.some((r) => r.name === name)) return setMessage(`"${name}" is taken.`)
      return setForm({ kind: 'routine-schedule', value: 'weekdays 9:00', editing: f.editing, name })
    }
    if (f.kind === 'routine-schedule') {
      const schedule = f.value.trim()
      const e = f.editing
      try {
        await saveRoutine(config.home, toRoutine(e, f.name, schedule, e.routine?.enabled ?? true))
      } catch (err) {
        return setMessage((err as Error).message)
      }
      setForm(null)
      setEditing(null)
      // A draft that became a routine is no longer a draft.
      if (!e.routine) await deleteDraft(config.home, e.id)
      setMessage(`${f.name} · ${schedule || 'no schedule'} · ${whenNext(schedule)}`)
      return void refresh(false)
    }
    if (f.kind === 'draft-remove') {
      setForm(null)
      await deleteDraft(config.home, f.id)
      setMessage(`Threw away ${f.name}.`)
      return void refresh(false)
    }
    if (f.kind === 'routine-remove') {
      setForm(null)
      await deleteRoutine(config.home, f.name)
      setMessage(`Removed ${f.name}. Its runs stay in Archived.`)
      return void refresh(false)
    }
  }

  const submitAccountForm = async (f: Form) => {
    if (f.kind === 'add-name') {
      const name = f.value.trim()
      if (!name) return setForm(null)
      if (config.accounts.some((a) => a.name === name)) return setMessage(`"${name}" is taken.`)
      const hasDefault = config.accounts.some((a) => a.configDir === null)
      return setForm({ kind: 'add-dir', name, value: hasDefault ? `~/.claude-${name}` : 'default' })
    }
    setForm(null)
    if (f.kind === 'add-dir') {
      const dir = f.value.trim()
      const account: Account = {
        name: f.name,
        label: f.name,
        configDir: dir === '' || dir === 'default' ? null : expandHome(dir),
      }
      const next = await commit((c) => addAccount(c, account), `added ${f.name}`)
      if (next) {
        setSel((s) => ({ ...s, accounts: next.accounts.findIndex((a) => a.name === account.name) }))
        await signIn(account)
      }
    } else if (f.kind === 'prefixes') {
      await commit(
        (c) => setPrefixes(c, f.name, parsePrefixList(f.value)),
        `${f.name} routes saved`,
      )
    } else if (f.kind === 'label') {
      await commit((c) => relabel(c, f.name, f.value), `renamed ${f.name}`)
    } else if (f.kind === 'remove') {
      await commit(
        (c) => removeAccount(c, f.name),
        `removed ${f.name} from Hopper; its login is untouched`,
      )
      setSel((s) => ({ ...s, accounts: Math.max(0, s.accounts - 1) }))
    }
  }

  const settings = makeSettingsActions(ctx, commit)
  const submitForm = (f: Form) =>
    f.kind.startsWith('setting')
      ? settings.submitSettingsForm(f)
      : f.kind.startsWith('routine-') || f.kind === 'draft-remove'
        ? submitRoutineForm(f)
        : submitAccountForm(f)

  // Up next. Queued work starts on its own, unattended: the open app dispatches whenever
  // something changes that could make it ready (autopilot.ts), and `g` runs one now. Queueing for now dispatches straight away.
  const dispatchNow = async (quiet = false) => {
    if (!quiet) setMessage('Dispatching…')
    try {
      const report = await dispatchOnce(config)
      await refresh(false)
      const n = report.started.length
      const first = report.waiting[0]
      if (n) setMessage(`Started ${n}: ${report.started.map((x) => x.name).join(', ')}`)
      else if (!quiet)
        setMessage(
          first ? `Nothing started. ${first.name}: ${first.reason}.` : 'Nothing is queued.',
        )
    } catch (err) {
      setMessage(`Dispatch failed: ${(err as Error).message}`)
    }
  }

  const QUEUE_WORDS = {
    now: 'Queued: starts when it is ready and an account has room.',
    night: `Queued for tonight (${config.overnight.window}).`,
  }

  const setQueue = async (e: Editing, queue: Draft['queue']) => {
    const { queue: _q, proposed: _p, ...rest } = e.extra ?? {}
    const extra = { ...rest, ...(queue ? { queue } : {}) }
    await saveEdit({ ...e, extra }, queue ? QUEUE_WORDS[queue] : 'Unqueued: a draft again.')
    if (queue === 'now') void dispatchNow(true)
  }

  // Load the night: every proposed draft queued for tonight at once.
  const queueProposed = async () => {
    const proposed = (snap?.drafts ?? []).filter((d) => d.proposed && !d.queue)
    if (!proposed.length) return setMessage('Nothing proposed.')
    for (const d of proposed) {
      const { proposed: _p, ...rest } = d
      await saveDraft(config.home, { ...rest, queue: 'night', updated: now() })
    }
    await refresh(false)
    setMessage(`Queued ${proposed.length} for tonight (${config.overnight.window}).`)
  }

  return {
    go,
    focusProject,
    dispatchNow,
    setQueue,
    queueProposed,
    newConversation,
    keepDraft,
    start,
    trust,
    markDone,
    hold,
    enter,
    open,
    openChanges,
    enterRoutine,
    editRoutine,
    writeOutside,
    writeOutsideHere,
    markReportsRead,
    markAllReports,
    readReport,
    reportConversation,
    keepRoutine,
    editingOf,
    saveEdit,
    runNow,
    commit,
    signIn,
    submitForm,
    ...settings,
  }
}

export type Actions = ReturnType<typeof makeActions>
