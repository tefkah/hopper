# Hopper, for agents

<!-- Written by Hopper from docs/agents.md in its repo. Edits here are overwritten. -->

This folder is Hopper's home. Hopper is a terminal app the person keeps open all day to hand work
to Claude Code conversations across several projects and Claude logins. You are probably one of
those conversations. This page says how Hopper works, so you can use it rather than guess.

Never edit Hopper's state files by hand (`state/`, `drafts/`, `routines/*.md` front matter).
Use the `hopper` command.

## Projects and keys

Every project has a key shaped like a folder: `meta/inbox`, `bh/atlas`, `pm/tern`. `meta/`
projects live in this folder (`projects/<key>/_open.md`) and their conversations run here.
`bh/` and `pm/` projects come from a meta repo's registry; their conversations run from that repo,
and their open items are in its `planning/<key>/_open.md`, governed by that repo's planning rules.

`hopper list --json` prints every project with its folder, open file and where it runs.

## Conversations and drafts

A conversation is a Claude Code background session Hopper started. A **draft** is a conversation
that hasn't started yet: a first message waiting in `drafts/`. The person starts drafts from the
app; queued drafts start on their own (below).

Make a draft with:

```
hopper draft new --project <key> [--model haiku|sonnet|opus|opus[1m]|fable] [--effort low|medium|high] \
  [--done "<what finished looks like>"] [--after <draft id>[,<id>…]] [--queue now|night] \
  [--proposed <who>] "<the first message>"
```

It prints the new draft's id. Pass `-` as the message to read it from stdin.

- `--proposed <who>` marks it as proposed for the person to approve (`who` is your routine's
  name). Proposed drafts never start on their own. This is what routines that plan work use.
- `--queue now` starts it on its own as soon as an account has room; `--queue night` only inside
  the night window. Queued work runs unattended.
- `--after` holds it until the named drafts' conversations have finished cleanly (their result
  says `needs: nothing`, or the person marked them done).
- `--done` is the definition of done an unattended run is given.

## Unattended runs

Routines and queued drafts run with nobody watching, in auto permission mode (Claude decides
what is safe rather than asking). A model with no auto mode (Haiku) runs in dontAsk mode instead:
it may read, search, look at git history and use `hopper list` and `hopper draft new`, and write
only in its result folder; anything else is denied without asking. Such a run is told
where its result file is. A queued draft's result starts with exactly `needs: you` or
`needs: nothing`, then a one-line summary, then detail. `needs: nothing` sends it straight to
Done; `needs: you` puts it in front of the person. A routine's result is a report: a one-line
summary, then detail, with no `needs:` line. The person reads reports as they come.

Unattended runs work in a git worktree on a branch, never push to main, merge, deploy, publish or
send, and never edit planning files: they say in the result what should change. When a decision
is needed they take the recommended option and say so; when blocked they write the question in
the result and stop.

A run with a draft id may queue its own follow-ups with `hopper draft new --after <its id>`. Past
the chain depth set in Hopper's config, follow-ups become proposals instead.

## Up next and the night

`hopper dispatch` starts every queued draft that is ready, on the first account on its route
that is signed in, has room, and isn't already running its share. At night it also keeps to the
night's budget (points of the weekly limit one night may use) and to a reserve kept for the day.
The open Hopper app runs it whenever something changes that could make a draft ready, and runs
routines at their times; with the app closed, nothing starts. `hopper dispatch --json` says what
started and why the rest wait.

## Routines

A routine is `routines/<name>.md`: front matter, then the prompt.

```
---
project: meta/inbox
schedule: daily 7:00
model: sonnet
effort: low
enabled: true
check: just check
---
The prompt.
```

- `schedule` in words: `daily 7:00`, `weekdays 7:00, 13:00`, `weekly mon 9:00`,
  `monthly 1st 9:00`, `hourly`; blank for run-now only. Routines run only while the Hopper app
  is open: at their time, or if it opens within an hour after.
- `check` (optional) is a shell command run first, in the project's run folder. If it passes,
  the run is recorded and no conversation starts. If it fails, the conversation starts with its
  output.
- Each run writes `routines/<name>/runs/<date>.md` (the path is in its prompt), and can read the
  previous run's result for continuity.
- `hopper routine check <name>` says whether a routine file is valid and scheduled.
  `hopper routine templates` lists the routines Hopper ships; `hopper routine install <template>`
  adds one, paused.

## Reading what Hopper sees

`hopper list --json` prints everything: projects, drafts (with whether each is ready to start
and why not), conversations (group, project, model, ranOn: the full id its newest reply came
from, account, state, startedAt, activeAt: which lists sort by, when I last wrote to it while
it works and when Claude stopped once it has, result), routines and recent runs, and the last dispatch. A draft's or routine's `model` and
`effort` are null where it picks none; it then runs with `defaults`, the project's (on each
project) or Hopper's (at the top). So is a draft's `worktree` (`yes` to work in a git worktree,
`no` to edit the run folder in place), which only counts when the person starts it: queued work
and routines always get a worktree. A conversation's `worktree` is what it started with.
`hopper status --json` adds accounts and usage.

Groups a conversation can be in: `waiting` (on the person), `held` (waiting, but the person has
put it on hold until they can act, a meeting first; it counts nowhere, and a reply ends it),
`draft`, `proposed`, `running`,
`routines`, `next` (queued), `done`, and `filed`: a routine's run that has finished, which
lives with its routine's reports rather than in the list.
