import { dirname } from 'node:path'

import type { Project } from './home.ts'

// What Claude is told about the project when Hopper starts a conversation in it.
// Unattended, the closing "talk it through first" is left off: nobody is there to talk to. So is
// keeping the open file current, since unattended runs never edit planning files.
// `guide` is the agents' guide in the home folder; a conversation running there loads it as its
// CLAUDE.md, so only one running elsewhere is pointed at it.
export function hopperPrompt(
  project: Project,
  opts: { unattended?: boolean; guide?: string | undefined } = {},
): string {
  const { key, openFile, meta } = project
  const talk = opts.unattended
    ? []
    : ['Start by talking it through. Do not start on the work itself unless they ask.']
  const guide =
    opts.guide && dirname(opts.guide) !== project.runIn
      ? [
          `How Hopper works, for agents (making drafts, queueing, the hopper command): ${opts.guide}.`,
          'Read it when the person asks for something in Hopper.',
        ]
      : []
  // People end a conversation without asking for the cleanup, so finished items stay open.
  const keep = (how: string) =>
    opts.unattended
      ? []
      : [
          `When something done in this conversation finishes or changes an open item, ${how} before you stop, without being asked,`,
          'and say what you changed. The person often ends a conversation without asking for it.',
        ]
  const opening = `This conversation was started from Hopper, for the project ${key}.`
  // A registry project's open file belongs to its meta repo, which has its own planning rules.
  if (meta) {
    const where = meta.key
      ? `Its open items live in ${openFile}, in the meta repo ${meta.repo}.`
      : `This is the meta repo itself; each project's open items live in ${meta.repo}/planning/<key>/_open.md.`
    const code = meta.key ? (meta.link ?? project.path) : null
    return [
      opening,
      ...(code && project.runIn !== project.path
        ? [
            `You are running from the meta repo ${meta.repo} so its CLAUDE.md and conventions apply;`,
            `the project's code is in ${code}${meta.link ? ` (a link to ${project.path})` : ''}. Work there, and read its own CLAUDE.md before changing it.`,
          ]
        : []),
      where,
      `Before editing any planning file, read the planning rules in ${meta.repo}/CLAUDE.md and what it points to, and follow them`,
      '(which sections items go under, moving finished items to _done.md, dates, the planning check).',
      'When the person asks you to file, add or capture something, add it there and say what you added.',
      "If the open file doesn't exist yet, ask before creating it.",
      ...keep('update the open file under those rules'),
      ...guide,
      ...talk,
    ].join(' ')
  }
  return [
    opening,
    ...(project.runIn !== project.path ? [`Its folder is ${project.path}.`] : []),
    `Its open items live in ${openFile}, one per line as "- [ ] **Title** — detail", under the file's first "## " heading.`,
    'When the person asks you to file, add or capture something, add it to that file',
    `(create it with "# ${key}" and "## Open" if it is missing) and say what you added.`,
    ...keep('update its line, or remove it when it is done,'),
    ...guide,
    ...talk,
  ].join(' ')
}

// What a conversation started with nobody watching is told on top of the project prompt, so it
// never sits waiting on a question until morning. `result` is where it reports; `draft` is its
// own id, which follow-ups name in --after.
export function unattendedPrompt(opts: {
  result: string
  draft?: string | undefined
  done?: string | undefined
  depth?: number | undefined
  chainDepth: number
}): string {
  const { result, draft, done } = opts
  const depth = opts.depth ?? 0
  return [
    'Nobody is watching this conversation: it was started by Hopper while the person is away.',
    'The person has asked for this work to be done, so do it',
    'rather than only talking it through. Never wait for an answer; nobody will reply until morning.',
    done ? `It is finished when: ${done}.` : '',
    'Rules: make changes in a git worktree on a branch of the repo you change, and commit there.',
    'Never push to main, merge, force-push, deploy, publish, or send anything to anyone.',
    'Do not edit any _open.md or other planning file; say in the result what should change there.',
    'When a decision is needed, take the option you would recommend and say so in the result.',
    'For a real fork in the road, do both on two branches and say which you recommend.',
    'If you are blocked (a missing credential, a question only the person can answer), stop, and',
    'put the question in the result.',
    `When you finish or stop, write a result to ${result} (create the folder if needed).`,
    'Its first line must be exactly "needs: you" if anything is waiting on the person (a',
    'decision, a review, a question, branches to merge), or "needs: nothing" if not. Then a',
    'one-line summary, then detail: branches and commits, decisions you took, what is left.',
    draft && depth < opts.chainDepth
      ? `If the work leaves an obvious next step that can run unattended, you may queue it with:
hopper draft new --after ${draft} --done "<what finished looks like>" "<the prompt>"
(add --project <key> for another project). It starts once this conversation is done and its result says "needs: nothing". Queue at most two, and none for anything that needs the person.`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
}
