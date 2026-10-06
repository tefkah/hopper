import { Text } from 'ink'

import type { Choice } from '../../../config.ts'
import type { Draft } from '../../../drafts.ts'
import { ago, wrapText } from '../../../format.ts'
import type { OpenItem } from '../../../items.ts'
import { isWorking, OTHER, type Item } from '../../../model.ts'
import { tildify } from '../../../paths.ts'
import { draftKeys, holdKey } from '../../keymap.ts'
import { modelLabel } from '../../state.ts'
import { stateMark, T } from '../../theme.ts'
import { Heading, Keys, Mark } from '../primitives.tsx'
import { OpenItems, row, stateWords, title } from './parts.tsx'

// What kind of draft it is, in a few words.
const draftWords = (d: Draft | undefined) =>
  d?.queue === 'night'
    ? 'queued for tonight · runs unattended'
    : d?.queue === 'now'
      ? 'queued · starts when there is room, unattended'
      : d?.proposed
        ? 'proposed · u queues it'
        : 'draft'

// A draft as it sits on the list: its settings, its keys, then its text, read only. ⏎ is the
// only way back into writing it.
export function DraftDetail({
  item,
  draft,
  defaults,
  width,
}: {
  item: Item
  draft?: Draft | undefined
  defaults: Choice
  width: number
}) {
  const lines = wrapText(draft?.text ?? '', width)
  while (lines.length && !lines.at(-1)) lines.pop()
  return (
    <>
      {title(item.name)}
      <Text>
        <Mark state={item.state} kind="draft" />
        <Text color={T.draft}>{' ' + draftWords(draft)}</Text>
        <Text color={T.dim}>{` · last edit ${ago(item.startedAt)} ago`}</Text>
      </Text>
      <Text> </Text>
      {row('project', item.key)}
      {row('model', modelLabel(draft?.model, draft?.effort, defaults))}
      {draft?.queue
        ? row('starts', item.waiting ?? 'on the next dispatch', item.waiting ? T.waiting : T.text)
        : null}
      {draft?.after?.length ? row('after', draft.after.join(', ')) : null}
      {draft?.done ? row('done when', draft.done) : null}
      {draft?.proposed ? row('from', draft.proposed) : null}
      {draft ? row('id', draft.id) : null}
      <Text> </Text>
      <Keys keys={draftKeys({ ...draft, defaults })} width={width} />
      <Text> </Text>
      <Heading label="text · ⏎ to keep writing" width={width} />
      {lines.map((l, i) => (
        <Text key={i} color={T.text}>
          {l || ' '}
        </Text>
      ))}
    </>
  )
}

export function ConversationDetail(props: {
  item: Item
  openItems?: OpenItem[] | null | undefined
  width: number
}) {
  const { item, openItems, width } = props
  const state = item.held ? 'held' : item.state
  const { color } = stateMark(state, item.kind)
  const inList = item.where !== 'done'
  return (
    <>
      {title(item.name)}
      <Text wrap="truncate-end">
        {inList ? <Mark state={state} kind={item.kind} /> : <Text color={T.faint}>✓</Text>}
        <Text color={inList ? color : T.dim}>{' ' + stateWords(item)}</Text>
        <Text color={T.dim}>{` · started ${ago(item.startedAt)} ago`}</Text>
        {ago(item.activeAt) !== ago(item.startedAt) ? (
          <Text color={T.dim}>
            {` · ${isWorking(item) ? 'last written to' : 'stopped'} ${ago(item.activeAt)} ago`}
          </Text>
        ) : null}
      </Text>
      <Text> </Text>
      {row('project', item.key === OTHER ? 'none of Hopper’s projects' : item.key)}
      {row('cwd', tildify(item.cwd))}
      {row('login', `${item.account} · ${item.kind}`)}
      {/* Hopper records what it asked for when it started a conversation; for one it didn't
          start, or started before it recorded both, Claude Code doesn't say. What it ran on is
          the full id from its transcript. */}
      {row('model', `${item.model ?? 'not known'} · ${item.effort ?? 'not known'}`)}
      {item.ranOn ? row('ran on', item.ranOn) : null}
      {item.routine ? row('routine', item.routine) : null}
      {item.result?.summary ? row('result', item.result.summary) : null}
      {item.id ? row('id', item.id) : null}
      <Text> </Text>
      {item.id ? (
        <Keys
          keys={
            inList
              ? [
                  ['⏎', 'open here'],
                  ['e', 'archive'],
                  ...holdKey(item),
                  ['i', 'interrupt'],
                  ['d', 'what it changed'],
                ]
              : [
                  ['⏎', 'open here'],
                  ['e', 'bring it back'],
                  ['d', 'what it changed'],
                ]
          }
          width={width}
        />
      ) : (
        <Text color={T.dim}>Interactive session: switch to its terminal.</Text>
      )}
      {openItems?.length ? (
        <>
          <Text> </Text>
          <Heading label={`open in ${item.key}`} width={width} />
          <OpenItems items={openItems} max={8} width={width} />
        </>
      ) : null}
    </>
  )
}
