import { describe, expect, test } from 'claude-code/testing'
import {
  applyCuts,
  cardText,
  isCard,
  pairingProblem,
  estimateTokens,
  recoveryText,
  roundsFrom,
  selectCuts,
  shadowHolds,
  shadowPath,
  shadowRead,
  shadowRecord,
  sha256Hex,
  CARD_MARK,
  DEFAULT_LIMITS,
  type Row,
} from './plan'

/** A text of `tokens` estimated tokens (four characters to the token). */
function big(tokens: number): string {
  return 'x'.repeat(tokens * 4)
}

function callRow(id: string, tool: string, handle?: string): Row {
  return { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool }], handle }
}

function resultRow(
  entries: readonly { id: string; text: string; isError?: boolean }[],
  handle?: string,
): Row {
  return {
    role: 'user',
    text: '',
    toolResults: entries.map((entry) => ({
      tool_use_id: entry.id,
      text: entry.text,
      isError: entry.isError,
    })),
    handle,
  }
}

function promptRow(text: string): Row {
  return { role: 'user', text }
}

/** `rounds` finished tool rounds, each 2000 tokens of output, newest last. */
function conversation(rounds: number, tokens = 2000): Row[] {
  const rows: Row[] = [promptRow('do some work')]
  for (let i = 0; i < rounds; i += 1) {
    rows.push(callRow(`call-${i}`, 'Bash'))
    rows.push(resultRow([{ id: `call-${i}`, text: big(tokens) }]))
  }
  rows.push(promptRow('and now something else'))
  return rows
}

const FIFTY_K = { ...DEFAULT_LIMITS, totalTokens: 50_000 }

describe('the copy a card names', () => {
  test('every cut carries the path its plan was given', () => {
    const plan = selectCuts(conversation(4), { ...FIFTY_K, shadowOf: (id) => `/shadow/${id}.json` })
    expect(plan.cuts.length).toBeGreaterThan(0)
    for (const cut of plan.cuts) {
      expect(cut.card).toContain(`Full original kept as JSON at /shadow/${cut.toolUseId}.json`)
    }
  })

  test('the path survives into the rebuilt row', () => {
    const rows = conversation(4)
    const plan = selectCuts(rows, { ...FIFTY_K, shadowOf: (id) => `/shadow/${id}.json` })
    const after = applyCuts(rows, plan.cuts)
    const cards = after.flatMap((row) => (row.toolResults ?? []).map((r) => r.text)).filter(isCard)
    expect(cards.length).toBe(plan.cuts.length)
    for (const card of cards) expect(card).toContain('Full original kept as JSON at /shadow/')
  })
})

describe('roundsFrom', () => {
  test('a call and the rows that answer it are one round', () => {
    const rows = conversation(2)
    const rounds = roundsFrom(rows)
    expect(rounds.length).toBe(2)
    expect(rounds[0]?.start).toBe(1)
    expect(rounds[0]?.results).toEqual([2])
  })

  test('a call with no answer is not a round', () => {
    const rounds = roundsFrom([promptRow('go'), callRow('a', 'Bash')])
    expect(rounds[0]?.results).toEqual([])
  })

  test('a message split into one row per block is still one round', () => {
    // One assistant message making two calls, then the message answering both:
    // four rows here, one round.
    const rows: Row[] = [
      promptRow('go'),
      callRow('a', 'Read'),
      callRow('b', 'Bash'),
      resultRow([{ id: 'b', text: big(2_000) }]),
      resultRow([{ id: 'a', text: big(2_000) }]),
      promptRow('next'),
    ]
    const rounds = roundsFrom(rows)
    expect(rounds.length).toBe(1)
    expect(rounds[0]?.start).toBe(1)
    expect(rounds[0]?.results).toEqual([3, 4])
    // The prompt written after the results is not part of the round.
    expect(rounds[0]?.end).toBe(4)
  })
})

describe('selectCuts', () => {
  test('nothing is cut below the threshold', () => {
    const plan = selectCuts(conversation(5), { ...DEFAULT_LIMITS, totalTokens: 5_000 })
    expect(plan.cuts).toEqual([])
  })

  test('nothing is cut at the official-compaction gate', () => {
    const plan = selectCuts(conversation(5), { ...DEFAULT_LIMITS, totalTokens: 650_000 })
    expect(plan.cuts).toEqual([])
  })

  test('the newest three rounds are kept verbatim', () => {
    const plan = selectCuts(conversation(5), FIFTY_K)
    expect(plan.cuts.map((cut) => cut.toolUseId)).toEqual(['call-0', 'call-1'])
  })

  test('a result under the chunk floor is left alone', () => {
    const rows: Row[] = [
      promptRow('go'),
      callRow('a', 'Bash'),
      resultRow([{ id: 'a', text: big(500) }]),
      callRow('b', 'Bash'),
      resultRow([{ id: 'b', text: big(2000) }]),
      callRow('c', 'Bash'),
      resultRow([{ id: 'c', text: big(2000) }]),
      callRow('d', 'Bash'),
      resultRow([{ id: 'd', text: big(2000) }]),
      callRow('e', 'Bash'),
      resultRow([{ id: 'e', text: big(2000) }]),
      promptRow('next'),
    ]
    const plan = selectCuts(rows, FIFTY_K)
    // `a` is a candidate round but under the floor; `b` is the next one.
    expect(plan.cuts.map((cut) => cut.toolUseId)).toEqual(['b'])
  })

  test('a failed result keeps its diagnostics', () => {
    const rows: Row[] = [
      promptRow('go'),
      callRow('a', 'Bash'),
      resultRow([{ id: 'a', text: big(2000), isError: true }]),
      callRow('b', 'Bash'),
      resultRow([{ id: 'b', text: big(2000) }]),
      callRow('c', 'Bash'),
      resultRow([{ id: 'c', text: big(2000) }]),
      callRow('d', 'Bash'),
      resultRow([{ id: 'd', text: big(2000) }]),
      callRow('e', 'Bash'),
      resultRow([{ id: 'e', text: big(2000) }]),
      promptRow('next'),
    ]
    const plan = selectCuts(rows, FIFTY_K)
    // `a` failed and is a candidate: its diagnostics stay. `b` cuts as usual.
    expect(plan.cuts.map((cut) => cut.toolUseId)).toEqual(['b'])
  })

  test('a round holding a long read is cut for that read alone', () => {
    const rows: Row[] = [
      promptRow('go'),
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'read-1', tool: 'Read' },
          { tool_use_id: 'bash-1', tool: 'Bash' },
        ],
      },
      resultRow([
        { id: 'read-1', text: big(2000) },
        { id: 'bash-1', text: big(2000) },
      ]),
      callRow('a', 'Bash'),
      resultRow([{ id: 'a', text: big(2000) }]),
      callRow('b', 'Bash'),
      resultRow([{ id: 'b', text: big(2000) }]),
      callRow('c', 'Bash'),
      resultRow([{ id: 'c', text: big(2000) }]),
      promptRow('next'),
    ]
    const plan = selectCuts(rows, FIFTY_K)
    expect(plan.cuts.map((cut) => cut.toolUseId)).toEqual(['read-1'])
  })

  test('a huge result becomes a pointer alone', () => {
    const rows: Row[] = [
      promptRow('go'),
      callRow('a', 'Bash'),
      resultRow([{ id: 'a', text: big(40_000) }]),
      callRow('b', 'Bash'),
      resultRow([{ id: 'b', text: big(2000) }]),
      callRow('c', 'Bash'),
      resultRow([{ id: 'c', text: big(2000) }]),
      callRow('d', 'Bash'),
      resultRow([{ id: 'd', text: big(2000) }]),
      promptRow('next'),
    ]
    const plan = selectCuts(rows, FIFTY_K)
    expect(plan.cuts.length).toBe(1)
    expect(plan.cuts[0]?.pointer).toBe(true)
    expect(plan.cuts[0]?.card).toContain('pointer only')
  })

  test('a card already there is the floor: nothing before it is cut again', () => {
    const rows: Row[] = [
      promptRow('go'),
      callRow('a', 'Bash'),
      resultRow([{ id: 'a', text: big(2000) }]),
      callRow('b', 'Bash'),
      resultRow([{ id: 'b', text: cardText({ tool: 'Bash', toolUseId: 'b', text: '', pointer: false }) }]),
      callRow('c', 'Bash'),
      resultRow([{ id: 'c', text: big(2000) }]),
      callRow('d', 'Bash'),
      resultRow([{ id: 'd', text: big(2000) }]),
      callRow('e', 'Bash'),
      resultRow([{ id: 'e', text: big(2000) }]),
      promptRow('next'),
    ]
    const plan = selectCuts(rows, FIFTY_K)
    expect(plan.cuts.map((cut) => cut.toolUseId)).toEqual([])
  })

  test('a round the newest prompt opened is not cut', () => {
    const rows: Row[] = [promptRow('go')]
    for (let i = 0; i < 4; i += 1) {
      rows.push(callRow(`old-${i}`, 'Bash'))
      rows.push(resultRow([{ id: `old-${i}`, text: big(2000) }]))
    }
    rows.push(promptRow('new task'))
    rows.push(callRow('fresh', 'Bash'))
    rows.push(resultRow([{ id: 'fresh', text: big(2000) }]))

    const plan = selectCuts(rows, FIFTY_K)
    expect(plan.cuts.map((cut) => cut.toolUseId)).toEqual(['old-0'])
  })

  test('with no figure from the engine the rows are counted, tool output included', () => {
    // `totalTokens: 0` is what a session with no usage reading looks like.
    const plan = selectCuts(conversation(5, 5_000), { ...DEFAULT_LIMITS, totalTokens: 0 })
    // Five rounds of 5,000 tokens of output: over the 20,000 threshold, even
    // though every row's own `text` is empty and only the blocks carry weight.
    expect(plan.tokensBefore).toBeGreaterThan(20_000)
    expect(plan.cuts.map((cut) => cut.toolUseId)).toEqual(['call-0', 'call-1'])
  })

  test('a result whose call carries media is never rebuilt', () => {
    const plan = selectCuts(conversation(5), {
      ...FIFTY_K,
      unrebuildable: new Set(['call-0']),
    })
    expect(plan.cuts.map((cut) => cut.toolUseId)).toEqual(['call-1'])
  })

  test('a row holding a media result is left whole, not only that result', () => {
    // One row can answer two calls; a rebuilt row speaks through its text
    // blocks alone, so cutting the text result would drop the image beside it.
    const rows: Row[] = [
      promptRow('go'),
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'shot', tool: 'Read' },
          { tool_use_id: 'dump', tool: 'Bash' },
        ],
      },
      resultRow([
        { id: 'shot', text: big(2000) },
        { id: 'dump', text: big(2000) },
      ]),
      callRow('b', 'Bash'),
      resultRow([{ id: 'b', text: big(2000) }]),
      callRow('c', 'Bash'),
      resultRow([{ id: 'c', text: big(2000) }]),
      callRow('d', 'Bash'),
      resultRow([{ id: 'd', text: big(2000) }]),
      promptRow('next'),
    ]
    const plan = selectCuts(rows, { ...FIFTY_K, unrebuildable: new Set(['shot']) })
    expect(plan.cuts).toEqual([])
  })

  test('the plan reports what it expects to save', () => {
    const plan = selectCuts(conversation(5), FIFTY_K)
    expect(plan.tokensBefore).toBe(50_000)
    expect(plan.tokensAfter).toBeLessThan(plan.tokensBefore)
  })
})

describe('applyCuts', () => {
  test('a cut row loses its handle and keeps its neighbours whole', () => {
    const rows = conversation(5)
    const handle = (index: number) => `h${index}`
    const withHandles = rows.map((row, index) => ({ ...row, handle: handle(index) }))

    const plan = selectCuts(withHandles, FIFTY_K)
    const after = applyCuts(withHandles, plan.cuts)

    expect(after.length).toBe(withHandles.length)
    // Round 0's result row is row 2 and was cut: rebuilt, so no handle.
    expect(after[2]?.handle).toBeUndefined()
    expect(isCard(after[2]?.toolResults?.[0]?.text)).toBe(true)
    // Its call row, and every row before it, are the engine's own.
    expect(after[1]?.handle).toBe('h1')
    expect(after[0]?.handle).toBe('h0')
    // The newest rounds keep their handles.
    expect(after[rows.length - 2]?.handle).toBe(`h${rows.length - 2}`)
  })

  test('the card says what it is, so it cannot pass for an instruction', () => {
    const card = cardText({ tool: 'Bash', toolUseId: 'c1', text: big(2000), pointer: false })
    expect(card.startsWith(CARD_MARK)).toBe(true)
    expect(card).toContain('not a new instruction')
    expect(card).toContain('c1')
  })

  test('a card keeps the arguments, both ends, the errors and the size', () => {
    // A tail alone is not enough to keep working from: the command that ran,
    // the opening lines and the line that failed are what a later turn reads.
    const body = Array.from({ length: 60 }, (_, index) => `line ${index}`)
    body[20] = 'npm ERR! command failed'
    const card = cardText({
      tool: 'Bash',
      toolUseId: 'c9',
      text: body.join('\n'),
      pointer: false,
      input: { command: 'npm test', description: 'Run tests' },
    })
    expect(card).toContain('Argument: {"command":"npm test"')
    expect(card).toContain('First lines:')
    expect(card).toContain('line 0')
    expect(card).toContain('Error lines:')
    expect(card).toContain('npm ERR! command failed')
    expect(card).toContain('Last lines:')
    expect(card).toContain('line 59')
    expect(card).toContain('60 lines')
  })

  test('a line too long for a card is clipped, not carried whole', () => {
    const card = cardText({
      tool: 'Bash',
      toolUseId: 'c10',
      text: `short\n${'y'.repeat(5_000)}\ntail`,
      pointer: false,
    })
    expect(card.length).toBeLessThan(2_000)
    expect(card).toContain('…')
  })

  test('a pointer still carries the arguments and both ends', () => {
    const body = ['first', big(40_000), 'last'].join('\n')
    const card = cardText({
      tool: 'Read',
      toolUseId: 'p1',
      text: body,
      pointer: true,
      input: { file_path: 'C:/a.txt' },
    })
    expect(card).toContain('pointer only')
    expect(card).toContain('Argument: {"file_path":"C:/a.txt"}')
    expect(card).toContain('first')
    expect(card).toContain('last')
  })

  test('a card names the copy it stands for, with the digest of the text', () => {
    // Without this line recovery means re-running the call, and a re-run hands
    // back the file as it is now — not the text that was cut.
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const card = cardText({
      tool: 'Bash',
      toolUseId: 'toolu_9',
      text,
      pointer: false,
      shadow: '/home/u/.claude/live-compact/shadow/s1/toolu_9.json',
    })
    expect(card).toContain('Full original kept as JSON at /home/u/.claude/live-compact/shadow/s1/toolu_9.json')
    expect(card).toContain(`(sha256 ${sha256Hex(text).slice(0, 8)})`)
    // A reader that has never seen this mod has to be told where in the file the
    // text sits, or the copy is a blob it cannot use.
    expect(card).toContain('the "text" field holds it verbatim')
    // The copy is the exact text; a re-run is the file as it is now.
    expect(card).toContain('the copy named above is the exact text')
    expect(card).not.toContain('read the same path again')
  })

  test('a card with no copy kept names none', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const card = cardText({ tool: 'Bash', toolUseId: 't', text, pointer: false })
    expect(card).not.toContain('Full original')
  })
})

describe('pairingProblem', () => {
  test('a conversation that pairs its calls with their results passes', () => {
    expect(pairingProblem(conversation(4))).toBeNull()
    expect(pairingProblem([promptRow('hi')])).toBeNull()
  })

  test('a rebuild that leaves the conversation sound is still sound', () => {
    const rows = conversation(5)
    const after = applyCuts(rows, selectCuts(rows, FIFTY_K).cuts)
    expect(pairingProblem(after)).toBeNull()
  })

  test('a result with no call before it is the shape that stops a session', () => {
    // What a cut that dropped a call leaves behind: the API rejects the whole
    // history with `tool_history_mismatch`, and every later turn sends it too.
    const rows: Row[] = [resultRow([{ id: 'gone', text: 'output' }]), promptRow('go')]
    expect(pairingProblem(rows)).toContain('answers no call')
  })

  test('a call id replayed at a second position, answered twice, is sound', () => {
    // This host replays a preserved message past a compaction: the same
    // assistant message lands again with a new uuid, results and all. The API
    // pairs per message, so both copies pair fine — refusing the cut over it
    // stood the mod down for the whole session.
    const rows: Row[] = [
      promptRow('go'),
      callRow('same', 'Bash'),
      resultRow([{ id: 'same', text: 'one' }]),
      callRow('same', 'Bash'),
      resultRow([{ id: 'same', text: 'two' }]),
    ]
    expect(pairingProblem(rows)).toBeNull()
  })

  test('a replayed call whose second copy is unanswered is caught', () => {
    const rows: Row[] = [
      promptRow('go'),
      callRow('same', 'Bash'),
      resultRow([{ id: 'same', text: 'one' }]),
      callRow('same', 'Bash'),
      promptRow('and again'),
    ]
    expect(pairingProblem(rows)).toContain('has no result')
  })

  test('two calls in one message are answered together, not one at a time', () => {
    // This host hands one row per content block: one assistant message making
    // two calls arrives as two call rows, and its answers as two result rows.
    // The API pairs them at message level, so a run of call rows is one
    // message. Reading it as two messages would call every parallel call
    // unanswered and stand the mod down for the whole session.
    const rows: Row[] = [
      promptRow('go'),
      callRow('a', 'Bash'),
      callRow('b', 'Bash'),
      resultRow([{ id: 'b', text: 'two' }]),
      resultRow([{ id: 'a', text: 'one' }]),
    ]
    expect(pairingProblem(rows)).toBeNull()
  })

  test('a call answered only after another message called is caught', () => {
    const rows: Row[] = [
      promptRow('go'),
      callRow('a', 'Bash'),
      promptRow('note'),
      callRow('b', 'Bash'),
      resultRow([{ id: 'b', text: 'two' }]),
      resultRow([{ id: 'a', text: 'one' }]),
    ]
    expect(pairingProblem(rows)).toContain('has no result before the next call')
  })

  test('a result that answers a call already answered is caught', () => {
    const rows: Row[] = [
      promptRow('go'),
      callRow('a', 'Bash'),
      resultRow([{ id: 'a', text: 'one' }]),
      callRow('b', 'Bash'),
      resultRow([{ id: 'a', text: 'one again' }]),
    ]
    expect(pairingProblem(rows)).toContain('answers no call before it')
  })

  test('a call still waiting at the end of the history is caught', () => {
    const rows: Row[] = [promptRow('go'), callRow('a', 'Bash')]
    expect(pairingProblem(rows)).toContain('tail')
  })

  test('a user row between a call and its result is not a break', () => {
    // The engine merges the rows of one role into one message, so text and the
    // result that follows it are still the message right after the call.
    const rows: Row[] = [promptRow('go'), callRow('a', 'Bash'), promptRow('note'), resultRow([{ id: 'a', text: 'x' }])]
    expect(pairingProblem(rows)).toBeNull()
  })
})

describe('shadowPath', () => {
  test('one folder per session, one record per call', () => {
    expect(shadowPath('/home/u', 'abc/def', 'toolu:1')).toBe(
      '/home/u/.claude/live-compact/shadow/abc_def/toolu_1.json',
    )
  })

  test('a trailing separator on home does not double', () => {
    expect(shadowPath('/home/u/', 's', 't')).toBe('/home/u/.claude/live-compact/shadow/s/t.json')
  })
})

describe('sha256Hex', () => {
  // The published vectors. A digest that only round-trips against itself
  // proves nothing: `hash(x) === hash(x)` holds for any function at all.
  test('the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  test('abc', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test('the two-block message', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  test('UTF-8 above the ASCII range', () => {
    // A Chinese character is three bytes; a length counted in characters
    // rather than bytes would pad the block wrongly and change the digest.
    expect(sha256Hex('你好')).toBe(
      '670d9743542cae3ea7ebe36af56bd53648b0a1126162e78d81a32934a711302e',
    )
  })

  test('a long text past a block boundary', () => {
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    )
  })
})

describe('shadowRecord', () => {
  test('carries the call, the size, the digest and the text', () => {
    const record = shadowRecord({ tool: 'Bash', toolUseId: 'toolu_1', text: 'hello' })
    expect(record.toolUseId).toBe('toolu_1')
    expect(record.tool).toBe('Bash')
    expect(record.chars).toBe(5)
    expect(record.sha256).toBe(sha256Hex('hello'))
    expect(record.text).toBe('hello')
  })

  test('survives a write and a read as JSON', () => {
    const record = shadowRecord({ tool: 'Read', toolUseId: 't', text: 'body\nline 2' })
    const back = shadowRead(JSON.stringify(record))
    expect(back).not.toBeNull()
    expect(shadowHolds(back!, record.text)).toBe(true)
  })

  test('a bare text is not a record', () => {
    // The 0.3.5 shadows are bare text. Reading one as a record must fail, not
    // parse into a shape whose fields happen to be undefined.
    expect(shadowRead('just the old text')).toBeNull()
    expect(shadowRead('{"text":"no digest here"}')).toBeNull()
  })

  test('a record whose text changed under its digest does not hold', () => {
    const record = shadowRecord({ tool: 'Bash', toolUseId: 't', text: 'original' })
    expect(shadowHolds(record, 'original')).toBe(true)
    expect(shadowHolds(record, 'something else')).toBe(false)
    expect(shadowHolds({ ...record, text: 'edited' }, 'edited')).toBe(false)
  })
})

describe('recoveryText', () => {
  test('a Read is fetched by its path', () => {
    expect(recoveryText('Read', false)).toContain('read the same path again')
  })

  test('a Bash result by the same command', () => {
    expect(recoveryText('Bash', false)).toContain('run the same command again')
  })

  test('a search by the same search', () => {
    expect(recoveryText('Grep', true)).toContain('run the same search again')
  })

  test('a pointer says the whole body went, not its middle', () => {
    expect(recoveryText('Read', true)).toContain('The body was dropped here')
    expect(recoveryText('Read', false)).toContain('The middle was dropped here')
  })
})

describe('a cut that must not cost more than it saves', () => {
  test('a text whose two ends would meet is kept once, not twice', () => {
    // Seven lines over 512 characters: the head keeps six of them and the tail
    // eight, so slicing both ends covers the same lines twice. Printing both
    // would leave a card longer than the result it replaced.
    const body = Array.from({ length: 7 }, (_, i) => `line ${i} ${'y'.repeat(90)}`).join('\n')
    expect(body.length).toBeGreaterThan(512)
    const card = cardText({ tool: 'Bash', toolUseId: 'call-1', text: body, pointer: false })
    const kept = card.split('\n').filter((line) => line.startsWith('line '))
    expect(kept.length).toBe(7)
    expect(new Set(kept).size).toBe(7)
  })

  test('a rebuilt row keeps the fields the cut never read', () => {
    // `agentId` is on the engine's message and not on this mod's row type.
    // Rebuilding by listing the fields would drop it on exactly the rows a cut
    // rewrites, and only on those.
    const rows = [
      { role: 'user', text: 'go' },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c1', tool: 'Bash' }] },
      {
        role: 'user',
        text: '',
        toolResults: [{ tool_use_id: 'c1', text: big(2_000) }],
        handle: 'h1',
        agentId: 'a7',
      },
      { role: 'user', text: 'tail' },
    ] as unknown as Row[]

    const plan = selectCuts(rows, { ...FIFTY_K, keepRounds: 0 })
    expect(plan.cuts.length).toBe(1)

    const after = applyCuts(rows, plan.cuts) as (Row & { agentId?: string })[]
    expect(after[2]?.agentId).toBe('a7')
    // `handle` is the one field a cut drops: it is what says "already sent".
    expect(after[2] && 'handle' in after[2]).toBe(false)
  })

  test('wide glyphs are weighed as they are, not as four latin characters', () => {
    // A 3,000-character Chinese result is ~2,000 tokens, not 750: at four
    // characters to the token `chunkMin` passes it over however large it is.
    expect(estimateTokens('汉'.repeat(3_000))).toBe(2_000)
    expect(estimateTokens('x'.repeat(4_000))).toBe(1_000)
    expect(estimateTokens('')).toBe(0)
  })
})
