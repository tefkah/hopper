# hopper

A terminal app, open all day in its own window, for work handed to Claude Code agents across
several projects and several Claude logins. It shows each login's sessions and usage, the projects
in Hopper's home folder, a queue of what's running, and what needs you. It dispatches and attaches;
Claude Code does the work. Ink (React for the terminal) on Node, run from `dist/` so it opens fast.

Plans live outside this repo. If there's a `CLAUDE.local.md` beside this file, read it first: it says
where they are.

## Things that are easy to get wrong

- **Never set `CLAUDE_CONFIG_DIR` for the default login.** With it set to `~/.claude`, the
  existing login reads as logged out. The default login (`config_dir = "default"`) runs with the
  variable unset; every other login gets it set to its own directory. See `src/claude.ts`.
- **`claude agents --json` has two shapes.** Background sessions carry `id` and `state`;
  interactive ones carry `pid` and `status`. Parse both.
- **Usage is a cache.** `cachedUsageUtilization` in the login's `.claude.json` can be days old.
  Always show its age next to the numbers.
- **No account is special in code.** Accounts and routes live in `accounts.toml` beside the
  config, written by Hopper (`src/config.ts` edits, `src/routing.ts` picks). A route maps a
  prefix to an ordered list of accounts; the first signed-in one with room runs the work.
- **`claude auth status` exits 1 when signed out** and creates the config dir as a side effect.
  Never call claude for an account whose directory doesn't exist (`isSetUp`).
- **A conversation is a Claude Code background session.** `tab` starts one with `claude --bg`
  in the project's run folder (`runIn`: a registry project's meta repo, a home project's home
  folder, else its own), with `hopperPrompt` appended so Claude knows the project's `_open.md`,
  then attaches. Claude reports a session that has answered as `done`; to Hopper that means
  _needs you_, until it's archived (`e`; still `<home>/state/done.json` and `done` in code).
  One can be put on hold (`h`, `<home>/state/held.json`): still waiting, but counted nowhere
  (`waitsOnMe`). The hold
  keeps when it was set, and a reply in the transcript after that ends it (`gather`), so there
  is nothing to clear by hand when the conversation moves on. `claude --bg` refuses
  untrusted folders (`UntrustedError`); trust is inherited, so Hopper trusts its home once.
- **Conversations are embedded, not attached in place of Hopper.** `src/tui/embed.ts` runs
  `claude attach <id>` in a node-pty, feeds @xterm/headless, and draws its screen into the right
  panel; keys are translated back to bytes. Run attach in the session's own cwd: Claude's agents
  view (its ← gesture) opens where attach runs, and seeing that screen is how Hopper knows to hand
  the keyboard back. Pass env with CLAUDE_CONFIG_DIR deleted, never set to undefined (node-pty
  turns it into the string "undefined"). node-pty's `spawn-helper` needs +x (postinstall).
- **Hopper turns on mouse reporting** (SGR, `src/tui/mouse.ts`) so the wheel arrives as events
  rather than arrow keys. Ink hands them over as text (`[<64;x;yM`); parse them before anything
  treats them as keys. Turn reporting off around anything that takes over the terminal. It asks
  for every movement (1003), for hover: only set state when the row under the pointer changes.
  Finding that row reuses the lists' own windowing (`workItemAt`, `itemLines`, `projectLines`,
  `accountLines`), so a change to how a list lays out its lines carries over to the mouse.
- **Claude does its own mouse selection** (it asks for "any" mouse tracking) and copies with OSC 52. The headless terminal has no clipboard, so `embed.ts` catches OSC 52 and Hopper copies.
  Hopper's own drag-select is only the fallback for programs that don't want the mouse.
- **Panels without the keys are drawn darker** by `Frame`'s `dimmed`: its outer box is Ink's
  internal `ink-box` with `internal_transform` (`dimLine` in `theme.ts`), which Ink runs over every
  line of text inside, after the text's own colours. `<Box>` doesn't take a transform and
  `<Transform>` can't hold boxes, so this leans on Ink internals: check it after an Ink upgrade
  (`test/dim.test.tsx`).
- **`d` (ctrl+\ inside one) opens a conversation's changes in nvim** (`src/changes.ts` finds them, `src/nvim.ts`
  opens them). The repository is where most of its edits are, from its transcript, else its
  newest `cwd`; a session in a meta repo often cds back before it stops. The Ghostty window is
  made through Ghostty's AppleScript (1.3+), which runs the command without my shell, so nvim
  goes by full path and PATH is passed along. Everything that runs a program is injected in tests.
- **Usage comes from `claude -p /usage`**, which is answered locally at no cost and refreshes the
  cache. Never read login tokens for it.
- **`z` keeps the Mac awake** (`src/awake.ts`, `useAwake` in `hooks.ts`): while it's on, a
  `caffeinate -i -w <hopper's pid>` child, so it quits with Hopper however Hopper ends. On or off
  is kept in `<home>/state/awake.json`, so a restart while I'm away doesn't drop it. App's
  `keepAwake` prop is what holds the Mac awake; tests pass a fake, and it's null off macOS.
- **Routines** (`src/routines/`): files in `<home>/routines/`, runs in `<home>/state/runs.jsonl`,
  results in `<home>/routines/<name>/runs/`. **Nothing runs with Hopper closed**: the open app
  runs a routine when its time has passed since its last run, catching up only within an hour
  (`src/autopilot.ts`, `useAutopilot` in `hooks.ts`, after every poll). There is no launchd;
  `removeLaunchd` takes out entries earlier versions made, when the app starts. Tests run with
  `HOPPER_NO_AUTOPILOT` set (vitest.config.ts); App's `autopilot` prop turns it back on. A run
  gets `--add-dir` on the routines folder so it can write its result, and what routines share,
  without asking. The model and routine of a conversation Hopper started are in
  `<home>/state/conversations.json`; Claude Code doesn't report them. A routine's reports are
  the files in its `runs/` folder (`listReports`), not the run log, so a report written some
  other way shows too; the log only adds which conversation wrote it.
- **Every conversation Hopper starts gets `--model` and `--effort`.** Left off, the login's own
  settings (or its plan) would decide, and Hopper couldn't say which. What a draft or routine
  doesn't pick comes from `defaultsFor` (`src/config.ts`): its project's, then `config.toml`'s,
  then `CHOICE_DEFAULTS`. Wherever a default applies it is shown by name (`choiceText`:
  "opus[1m] (default)"), never as a bare "default". A conversation's `ranOn` is the full model id
  its newest reply came from, read from its transcript (`src/transcript.ts`).
- **Unattended means a mode that never asks, and a result file.** Routine runs and anything
  `hopper dispatch` starts get `unattendedPermissions` (`src/claude.ts`): `--permission-mode
auto`, except for Haiku, which has no auto mode (Claude falls back to asking, and the run
  stalls), so it gets `dontAsk` and a narrow `--allowedTools` list. Absolute paths in a rule
  start with `//` (`Edit(//Users/…/**)`); `Write(...)` rules don't cover the Write tool. Their
  prompt (`unattendedPrompt` in `src/prompts.ts`, `routineInstructions` for routines) says never
  to wait, to work on a branch, and where to write the result. `startDraft` (`src/start.ts`) is
  the one way a draft starts, from the app or the dispatcher; don't start one another way.
- **A routine's finished runs are `filed`**, not listed or in Done (`gather` in `model.ts`):
  they live in the routine's reports. Only a run `blocked` on a question stays in waiting.
  Reports are read or unread (`src/seen.ts`, `state/read.json`), and nothing else: routine
  runs write no `needs:` line (queued drafts still do; chains depend on it). The routine's row
  carries a dot while any report is unread; it doesn't chime or count in the title. Reports
  older than `read.json` count as read, so a new file lights nothing. ⏎ on a routine hands the
  keyboard to the list in its details (`reports` in App, `sel` -1 is "edit the prompt").
- **Reports are laid out, not printed.** `src/tui/markdown.ts` reads a report with `marked`'s
  lexer and turns it into lines of styled spans already wrapped to the panel, one per line on
  screen, since the scroll keys count them (`reportLines`, `reportMaxScroll`). Links show their
  text and carry the URL as an OSC 8 hyperlink; Ink measures those correctly.
- **Up next is drafts with `queue:`.** `src/dispatch.ts` decides what is ready (`after:` names
  drafts; a dependency is finished when its conversation is in Done) and on which account
  (route order, `max_running`, the reserve, and at night the budget measured from
  `state/night.json`). One dispatch at a time (`state/dispatch.lock`). The open app dispatches
  when `dispatchSignal` changes (a draft queued, a conversation moving, night falling), and every
  five minutes while work is queued, for room freeing up on an account.
- **`docs/agents.md` is the agents' guide**, copied to `<home>/CLAUDE.md` whenever it differs
  (`src/guide.ts`). A change to a command agents use (`src/commands.ts`) changes it too.
  Routine templates are `templates/routines/*.md`.
- **Registry projects are read, never copied.** A `[[source]]` in `projects.toml` imports a meta
  repo's `paths.local` on every load (`loadSource` in `src/home.ts`); those projects carry
  `meta`, their open file sits in the meta repo, and `hopperPrompt` defers to that repo's planning
  rules rather than Hopper's own `## Open` shape. `extraDirs` gives the session `--add-dir` on the
  planning folder. Paths go through `realpath`: Claude reports a session's physical cwd.
- **Many projects share one run folder**, so a session's cwd can't say which project it is for.
  The project Hopper recorded when it started it (`conversations.json`) wins; cwd matching is the
  fallback, for sessions Hopper didn't start. `extraDirs` adds the project's own folder when it
  resolves outside the run folder (it does, through the meta repo's `projects/` symlink).
- **Keys are letters and esc.** Inside an embedded conversation every key is Claude's, esc
  included; the way back to Hopper is Claude's own ← at the empty prompt, or ctrl+] (one of three
  Ctrl bindings), and both leave it live. Claude's interrupt is ctrl+c (passed through) or `i` from
  the list. The other two, asked for: ctrl+g while writing a draft or routine prompt (and on a
  draft's row or the prompt's line, as `o`) goes on in `$EDITOR`, Claude Code's own key for that,
  on purpose; in a conversation ctrl+g is Claude's, passed through. ctrl+\ inside a conversation
  (or on its row) opens its diff, like `d`; Claude binds nothing to it. No other Ctrl or Cmd
  bindings. What the
  keys do is described once, in `src/tui/keymap.ts` (the key bar and `?` both read it); a key
  added or changed in `keys.ts` gets its line there too. `esc` goes up a level; the top level is
  a menu of single letters.
- **Releasing** (only when asked; unattended runs never release or deploy). From the main
  checkout on `main` with a clean tree (`scripts/release.ts` refuses otherwise):
  `pnpm release minor` (or `patch`, `major`, a version) bumps `package.json`, writes a
  `CHANGELOG.md` entry, commits `Release vX.Y.Z` and tags it, pushing nothing. With no terminal
  no editor opens, so the entry is every commit subject since the last tag, `Site:` ones
  included: rewrite it as a few plain lines about what changed in the app, amend the commit and
  retag (`git tag -fa`), all before pushing. Then `git push origin main vX.Y.Z`. The tag runs
  `.github/workflows/release.yml`: `pnpm check`, `scripts/pack.sh`, the GitHub Release, then
  `pnpm site:deploy`, so the site's header names the new version (it's written in at build
  time). Check the run (`gh run watch`) and the live page.
- **The site** (`site/`) deploys from CI. For a site-only change, run the release workflow by
  hand with `site` ticked (`gh workflow run release -f site=true`); that packs but publishes no
  release. Deploying from a laptop needs the deploy token in a gitignored `.env`, which only the
  main checkout has: from a worktree, wrangler falls back to its own login and can deploy to
  the wrong Cloudflare account. When the app's look changes, `pnpm site:capture` recaptures
  the frames (`site/frames.json`, committed) from the made-up world in `src/demo.ts`.

## Where things are

- `src/cli.tsx`: the `hopper` command (`init`, `status`, `login`, `run`, `routines`, and the TUI).
- `src/tui/App.tsx`: composition only. State, the lists worked out from it, the layout, render.
  Don't put behaviour back here.
- `src/tui/actions.ts`: what the app does (`makeActions(ctx)`). `src/tui/keys.ts`: what each key
  and mouse event does, one handler per mode (`makeInput(ctx, actions)`). Both take the `AppCtx`
  from `src/tui/context.ts`, rebuilt every render.
- `src/tui/hooks.ts`: polling (`useSnapshot`), usage, draft autosave, a project's open items.
- `src/tui/panes/` (the columns, draft editor, picker, conversation, help, key bar) and
  `src/tui/panels/` (rows, accounts, and `detail/` for the right panel). Row components are
  memoized; keep their props stable.
- `src/settings.ts`: the settings screen's model (every setting's value, set or default, and
  `projects.toml` as a document to edit); `src/tui/settingsActions.ts` writes changes back, and
  checks a `projects.toml` loads before keeping it; `src/tui/panes/SettingsPane.tsx` draws it. A
  new setting in any of the three files gets a row in `buildRows`.
- `src/commands.ts`: `hopper list`, `draft new`, `routine check|templates|install`, `dispatch`;
  `src/cli.tsx` only wires and prints them. `src/dispatch.ts`, `src/start.ts`, `src/guide.ts`.
- `src/fsutil.ts` (`readIfThere`, `writeAtomic`) and `src/frontmatter.ts`: use these for any
  state file rather than writing fs code again. A read-change-write of a state file goes through
  `inTurn` (one at a time) and `readForChange` (a file that doesn't parse is set aside, never
  written over); a load for showing may still fall back to empty. Tests share
  `test/helpers.ts` (`fakeClaude`).

## Its own rules

This project owns its architecture, stack, deployment, and naming. Lint and format are oxlint and
oxfmt; `pnpm check` runs typecheck, lint, tests and build. Tests need `FORCE_COLOR=0` when the
shell forces colour. Examples and fixtures use made-up names (`bh/atlas`, `pm/tern`, Blue Heron,
Pinemoor); keep real accounts, clients and projects out of the repo.
