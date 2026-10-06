# Hopper

Toss work in the hopper, hop from item to item.

Hopper is a terminal app for handing work to Claude Code. You keep it open all day in its own
window. It lists every conversation across your projects and your Claude logins, shows which ones
are waiting on you, and opens them right there in a panel. It can also run prompts on a schedule
and work through a queue overnight.

Hopper doesn't do the work itself. Claude Code does. Hopper starts conversations, keeps track of
them, and gets you back into the one that needs you.

Mac only for now.

## Install

You need Node 22.6 or later and [Claude Code](https://claude.com/claude-code), signed in.

```sh
curl -fsSL https://hopper.saltbark.com/install.sh | sh
```

That puts the latest release in `~/.hopper/app` and links `~/.local/bin/hopper`. Run it again to
upgrade, or set `HOPPER_VERSION=0.1.0` for a particular one. Then:

```sh
hopper init               # config, home folder, and your current Claude login as the first account
hopper status             # what Hopper sees, as text
hopper                    # the app
```

To build it from source instead, you also need pnpm:

```sh
git clone https://github.com/saltbark/hopper.git
cd hopper
pnpm install && pnpm build
pnpm link --global        # puts `hopper` on your PATH
```

## Releases

From `main` with a clean tree, `pnpm release patch` (or `minor`, `major`, or a version) sets the
version, adds the commits since the last tag to `CHANGELOG.md` (opened in `$EDITOR` to tidy),
commits and tags. It pushes nothing; `git push origin main vX.Y.Z` does. The tag runs the release
workflow on a Mac runner: `pnpm check`, then `scripts/pack.sh` makes `hopper.tar.gz` and its
`.sha256`, they go up as a GitHub Release, where `install.sh` fetches them, and the website is
deployed so it names the new version.

The website, [hopper.saltbark.com](https://hopper.saltbark.com), is `site/`. Its terminal is the
real app, captured against a made-up world (`pnpm site:capture` when the app's look changes).
Run the release workflow by hand with `site` ticked to deploy it without a release. The deploy
needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository secrets.

## The list

Hopper opens on Conversations: every conversation that isn't archived, grouped into running, waiting
on you, on hold, drafts, proposed, routines and up next, in that order. `J` `K` move between the
groups. Archived sits below. Above the list, beside Accounts, Projects shows the projects with
something waiting, running or used today.

`p` goes to Projects, ready to search. Type a few letters and it lists every project and folder
that matches. ⏎ narrows the list to it, `tab` starts a conversation there, `esc` goes back.
`esc` on the list shows every project again.

## Conversations

`tab` starts a new conversation as a draft. It's a real text box (arrows, option+arrows by word,
shift to select, ⏎ for new lines) and it saves as you type. `esc`, then `s` starts it, `w` moves
it to another project, `y` copies it, `e` throws it away (press it twice), or `esc` again
keeps it.

`o` on a draft opens its text in your own editor (`$VISUAL`, else `$EDITOR`, else vi) with Hopper
suspended; the draft's other fields stay as they are, and quitting with an error (vim's `:cq`)
changes nothing. `o` on a routine's prompt line does the same for its prompt. While writing,
ctrl+g (Claude Code's key for it) takes what's typed so far to your editor and brings it back into
Hopper's, the cursor at the end; on a draft's row it's `o`. To write every draft there, from `tab`
on, set `draft_editor = "external"` in `config.toml` (or in `,`).

A conversation opens in the right-hand panel. It's the actual Claude session, and every key goes
to Claude, `esc` included. To come back to Hopper, press ← at Claude's empty prompt, or ctrl+]
from anywhere. The conversation stays open, and ⏎ goes back in. Inside, ctrl+c interrupts Claude;
from the list, `i` sends it an esc. `e` archives a conversation.

`d` on a conversation (or in Archived), or ctrl+\ inside one, opens what it changed in nvim (the
keyboard stays in the conversation): everything since its branch
left the default branch, committed or not, in the worktree it moved into if it made one; on the
default branch itself, what isn't committed. It runs nvim's own `:DiffTool` (nvim 0.12, no plugin);
`diff_command` in `config.toml` changes that (`"DiffviewOpen {base}"` for diffview.nvim). It opens
in a new tab of an nvim started with `hopper nvim` (which listens on `nvim_server`, by default
`~/.cache/hopper/nvim.sock`), else in a new Ghostty window when Hopper runs in Ghostty on macOS,
else in Hopper's own terminal until nvim quits.

Ask Claude to file items and it will: it knows the project's `_open.md`. The first conversation in
a new folder asks you to trust the folder once (`T`).

Models: in a draft, after `esc`, `m` picks the model and `E` the effort. A project can set its own
defaults in `projects.toml` (`model = "haiku"`, `effort = "low"`), and `config.toml` sets Hopper's
(`model`, `effort`: `opus[1m]` and `high` when not set). Hopper always tells Claude which model and
effort to use, so a conversation runs the same whichever login starts it, and a default is always
shown by name: `opus[1m] (default)`. The list shows what each conversation started with, and a
conversation's details the full id of the model its newest reply came from (`ran on`).

## Keys and mouse

`p` `c` `v` `a` jump to projects, conversations, archived and accounts. `n` jumps to the first thing
waiting on you. `J` `K` (or shift+↑↓) move to the next group. `e` on a conversation archives it, as
in Gmail, or in Archived brings it back. → on the list opens a conversation and ← comes back, so the arrows
alone get you around. `x` twice quits.

The bottom line shows the keys for whatever is selected. `?` shows all of them.

The wheel scrolls whatever is under the pointer, and a click focuses a panel. A click selects a
row, and a second click does what ⏎ would. Drag inside a conversation to select text; letting go
copies it. Elsewhere, hold your terminal's selection modifier (often Option or Shift) to select.

## Projects

Hopper keeps a home folder (`~/hopper` unless you pick another). Projects inside it are keyed
`meta/<name>` and their conversations run there.

If you keep several repos under one planning repo (a "meta repo" with a `paths.local` that maps
project keys to folders, and `planning/<key>/_open.md` for each), a `[[source]]` in
`projects.toml` brings them all in under a prefix:

```toml
[[source]]
prefix = "bh"
repo = "~/work/blueheron-meta"
strip = "bh"             # registry key bh/atlas lists as bh/atlas, not bh/bh/atlas
# run_in = "project"     # run in each project's own folder instead of the meta repo
```

It's read fresh every time. The meta repo itself shows up as `<prefix>/meta`. Conversations run
from the meta repo, so its `CLAUDE.md` applies, and they're told to follow its planning rules. Any
`[[project]]` can set `run_in`.

## Accounts

Hopper works with more than one Claude login. In the app, `a` then `a` again adds one: a short
name, its config directory, then Claude's own sign-in. `e` sets the key prefixes it runs
(`bh/, meta/`, or `*` for everything). When several accounts run a prefix, work goes to the first
one that is signed in and has room. `1` makes an account first choice. The default account (`*`)
runs anything no prefix names.

Each usage bar has a tick at how far through its window you are. A fill short of the tick means
you're using less than an even pace. When there's room, a second line says when each limit resets.

## Routines

A routine is a prompt that runs on a schedule, each run its own conversation. Write it as a
draft, then `esc`, `r`: name it and say when it runs (`daily 7:00`, `weekdays 7:00, 13:00`,
`weekly mon 9:00`, `monthly 1st 9:00`, or blank to run it only by hand).

From a routine's row, `s` runs it now, `S` changes the schedule, `P` pauses, `e` removes it (twice) and
`M` marks its reports read. Each run writes a report under `<home>/routines/<name>/runs/`. ⏎ on a
routine lists its reports and starts on the newest unread one. A routine with unread reports has a dot on its
row.

Routines only run while Hopper is open, either at their time or when Hopper opens within an hour
of it. A run is skipped when every account for its project is full.

A routine with `check: <command>` in its front matter runs that command first. If it passes, no
conversation starts and nothing is spent. If it fails, the conversation starts with its output.

```
hopper routines                    list them and when they next run
hopper run <name>                  one run, now
hopper routine check <name>        is the file valid
hopper routine templates           the routines Hopper ships
hopper routine install <template>  add one, paused (P in the app resumes it)
```

The templates:

- `daily-brief` (Sonnet, mornings)
- `hopper-review` (Opus, weekly)
- `groomer` (Sonnet, evenings): proposes tonight's work
- `decision-memos` (Opus): a memo with a recommendation for each Decide item
- `checks`: no model unless `just check` fails
- `drift-check` (Haiku)
- `branch-review` (Sonnet, low effort)
- `mail-brief` (Sonnet, 6:30) and `mail-lookback` (Opus, Saturdays): read Gmail through Claude's
  Gmail connector for replies you owe, things you've forgotten, and people worth writing to again.
  Give them a project that routes to the account the connector is on. They keep a small ledger
  (names, dates, a few words, never message bodies) and never send, draft or change anything.

## Overnight

`u` on a draft queues it: once for when there's room, twice for tonight, three times for off.
Queued drafts run unattended. They're started in auto permission mode and told never to wait for
an answer, to work on a branch, never to push to main or send anything, and to write a result file.

A draft can wait for others (`after:`), and a run can queue its own follow-ups up to
`chain_depth`; past that they're only proposed. Proposed drafts have their own group: `u` queues
one, `U` queues them all for tonight.

The open app starts queued work as soon as something could make it ready, and checks every five
minutes while work is waiting. `g` runs it now. It keeps to `max_running` per account, to the
night's budget (how much of the weekly limit one night may use) and to a reserve kept for the day.
All of these are under Overnight in settings. Leave Hopper open for queued work to run.

`z` keeps the Mac awake while Hopper is open, so the night's work runs and a conversation can be
reached from your phone. It's off until you turn it on, then on until you press `z` again, and
Hopper remembers it across restarts. `awake`, in green at the right end of the key bar, says it's
on. It uses `caffeinate`, so the display still sleeps. A laptop still sleeps when its lid is
closed, unless it's plugged in and connected to a display. macOS only.

```
hopper draft new --project <key> [--queue now|night] [--after <id>] [--done "…"] "<message>"
hopper list [--json]     everything Hopper sees; what agents read
hopper dispatch [--json] start what's ready, and say why the rest wait
```

Hopper copies `docs/agents.md` into `<home>/CLAUDE.md`, so every conversation in the home folder
knows these commands.

## Settings

`,` shows every setting in `config.toml`, `accounts.toml` and `projects.toml` in one place: its
value, whether it's set or a default, and what it does. ⏎ edits one, `d` resets it or removes an
entry, `a` adds an account, source or project, and `o` opens the file in `$EDITOR`. The files are
the source of truth. Edits from the screen keep a file's header comment but not comments further
down.

## Development

```sh
pnpm dev          # run from source
pnpm check        # typecheck, lint, test, build
```

## License

MIT. See [LICENSE](LICENSE).
