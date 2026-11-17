import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import { isCard, MARKER, shadowPath, shadowRecord } from './plan'
import { resetState } from './register'

function big(tokens: number): string {
  return 'x'.repeat(tokens * 4)
}

type Row = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: unknown[]
  toolResults?: unknown[]
  handle?: string
}

/** Four finished rounds and a fresh prompt: the oldest rounds are cuttable. */
function conversation(): Row[] {
  const built: Row[] = [{ role: 'user', text: 'go', handle: 'h0' }]
  for (let i = 0; i < 4; i += 1) {
    built.push({
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: `call-${i}`, tool: 'Bash', input: {} }],
      handle: `h${i * 2 + 1}`,
    })
    built.push({
      role: 'user',
      text: '',
      toolResults: [{ tool_use_id: `call-${i}`, text: big(2_000), isError: false }],
      handle: `h${i * 2 + 2}`,
    })
  }
  built.push({ role: 'user', text: 'and now something else', handle: 'htail' })
  return built
}

type EngineOptions = {
  rows?: Row[]
  /** The rows the session answers with, read fresh on each call. */
  getRows?: () => Row[]
  tokens?: number
  /** The window the engine reports, when it differs from the test's 200k. */
  window?: number
  /** The count the engine reports its own summarizer fires at. */
  threshold?: number
  /** The host reports no fill at all, as an embedding host may. */
  noReading?: boolean
  /** A home directory, or null for a machine that has neither. */
  home?: string | null
  exists?: boolean
  /** The files the mod has written, kept across turns as the disk is. */
  disk?: Map<string, string>
  /** A disk that accepts a write and keeps nothing: the read-back must catch it. */
  dropWrites?: boolean
  /** Called once per `$.session.messages({ as: 'api' })` read. */
  onApiRead?: () => void
  /** The rows the engine puts on the wire, when they differ from the session's own. */
  apiRows?: () => Row[]
  /** Called once per `$.command.run` the mod asks for. */
  onCommandRun?: (input: { command: string; args?: string }) => void
}

/**
 * Stands for the engine beneath the plugin. Every hook here answers as a call
 * on `$` does, `{ value }`, and each registers once.
 */
function engineUnderTest(on: On, options: EngineOptions = {}): void {
  const seeded = options.rows ?? conversation()
  const home = options.home === undefined ? '/home/u' : options.home
  const disk = options.disk ?? new Map<string, string>()

  on('session.messages', (_, e) => {
    if (e.as === 'api') {
      options.onApiRead?.()
      return { value: (options.apiRows ? options.apiRows() : []) as never }
    }
    return { value: (options.getRows ? options.getRows() : seeded) as never }
  })
  on('session.usage', () => ({
    value: {
      context: {
        tokens: options.noReading ? undefined : (options.tokens ?? 50_000),
        window: options.window ?? 200_000,
        breakdown:
          options.threshold === undefined
            ? undefined
            : ({ autoCompactThreshold: options.threshold } as never),
      },
      rateLimits: [],
      startedAt: 0,
    },
  }))
  on('session.id', () => ({ value: 's1' }))
  on('command.run', (_, e) => {
    options.onCommandRun?.(e as { command: string; args?: string })
    return { text: '' }
  })
  on('env.get', (_, e) => {
    if (e.name === 'HOME') return { value: home ?? undefined }
    return { value: undefined }
  })
  on('fs.exists', () => ({ value: options.exists ?? false }))
  on('fs.read', (_, e) => ({ value: disk.get(e.path as string) ?? '' }))
  on('fs.write', (_, e) => {
    if (!options.dropWrites) disk.set(e.path as string, e.text as string)
    return { value: undefined }
  })
  on('clock.after', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'done' }))
}

function turn($: any): Promise<unknown> {
  return $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' } as never)
}

type CompactedMessages = {
  text: string
  handle?: string
  toolResults?: { text: string }[]
}[]

describe('the cut', () => {
  test('an old long result becomes a card and its row is rebuilt', async ($, on) => {
    resetState()
    engineUnderTest(on)

    const result = await $.session.compact({ trigger: 'manual', instructions: MARKER, messages: conversation() as never })
    if ('skip' in result) throw new Error('expected a compaction')
    const messages = result.messages as unknown as CompactedMessages

    expect(messages.length).toBe(10)
    // Round 0's result row (index 2) was cut: the engine reads it as built.
    expect(messages[2]?.handle).toBeUndefined()
    expect(isCard(messages[2]?.toolResults?.[0]?.text)).toBe(true)
    // The card names the copy that was just written, so a reader that has
    // never seen this mod can open the original instead of re-running a call.
    expect(messages[2]?.toolResults?.[0]?.text).toContain(
      'Full original kept as JSON at /home/u/.claude/live-compact/shadow/s1/call-0.json',
    )
    // Everything before the cut keeps the engine's handle, so the prefix the
    // last request already sent is the one this request opens with.
    expect(messages[0]?.handle).toBe('h0')
    expect(messages[1]?.handle).toBe('h1')
    // The newest rounds are untouched, handle and all.
    expect(messages[8]?.handle).toBe('h8')
    expect(messages[9]?.handle).toBe('htail')
  })

  test('the counts are left to the engine, which measures the list it is given', async ($, on) => {
    resetState()
    engineUnderTest(on)
    const result = await $.session.compact({ trigger: 'manual', instructions: MARKER, messages: conversation() as never })
    if ('skip' in result) throw new Error('expected a compaction')
    expect(result.tokensBefore).toBeUndefined()
    expect(result.tokensAfter).toBeUndefined()
  })

  test('a compaction that asked for a summary is left to the summarizer', async ($, on) => {
    resetState()
    engineUnderTest(on, { rows: [] })
    // Stands for core beneath the plugin: it answers the compaction the plugin
    // stepped aside from.
    on('session.compact', () => ({ skip: 'core summarized instead' }) as never)

    const result = await $.session.compact({
      trigger: 'manual',
      instructions: 'keep the plan',
      messages: conversation() as never,
    })
    if (!('skip' in result)) throw new Error('expected a skip')
    expect(result.skip).toBe('core summarized instead')
  })

  test('a compaction this mod did not ask for is handed on untouched', async ($, on) => {
    resetState()
    engineUnderTest(on, { rows: [] })
    on('session.compact', () => ({ skip: 'core took it' }) as never)

    // A person's own `/compact` carries no marker: it must reach core.
    const result = await $.session.compact({ trigger: 'manual', messages: conversation() as never })
    if (!('skip' in result)) throw new Error('expected a skip')
    expect(result.skip).toBe('core took it')
  })

  test('nothing finished to cut is a skip, not a summary', async ($, on) => {
    resetState()
    engineUnderTest(on)
    const short = [{ role: 'user', text: 'hi', handle: 'h0' }]

    const result = await $.session.compact({ trigger: 'manual', instructions: MARKER, messages: short as never })
    expect('skip' in result).toBe(true)
  })

  test('an original that cannot be kept stops its cut', async ($, on) => {
    resetState()
    engineUnderTest(on, { home: null })

    const result = await $.session.compact({ trigger: 'manual', instructions: MARKER, messages: conversation() as never })
    expect('skip' in result).toBe(true)
  })

  test('a write the disk did not keep leaves its result whole', async ($, on) => {
    resetState()
    // `$.fs` has no rename here, so the guarantee pi gets from tmp+rename is
    // bought by reading the record back. A disk that takes the write and keeps
    // nothing is exactly what that read-back is for.
    engineUnderTest(on, { dropWrites: true })

    const result = await $.session.compact({ trigger: 'manual', instructions: MARKER, messages: conversation() as never })
    if (!('skip' in result)) throw new Error('expected a skip')
    expect(result.skip).toContain('originals could not be kept')
  })

  test('a shadow already holding the same text is left as its first card made it', async ($, on) => {
    resetState()
    const text = big(2_000)
    const path = shadowPath('/home/u', 's1', 'call-0')
    // The same result cut twice — a session resumed and cut again — must not
    // rewrite the record its first card points at. The note stands in for
    // anything a first writer put there.
    const disk = new Map<string, string>([
      [path, JSON.stringify({ ...shadowRecord({ tool: 'Bash', toolUseId: 'call-0', text }), note: 'first writer' })],
    ])
    engineUnderTest(on, { disk, exists: true })

    const result = await $.session.compact({ trigger: 'manual', instructions: MARKER, messages: conversation() as never })
    if ('skip' in result) throw new Error('expected a compaction')
    const messages = result.messages as unknown as CompactedMessages
    expect(isCard(messages[2]?.toolResults?.[0]?.text)).toBe(true)
    expect(JSON.parse(disk.get(path) ?? '{}').note).toBe('first writer')
  })

  test('the /compact row this mod asked for is not carried forward', async ($, on) => {
    resetState()
    engineUnderTest(on)
    const rows = conversation()
    rows.splice(5, 0, {
      role: 'user',
      text: `<command-name>/compact</command-name>\n            <command-args>${MARKER}</command-args>`,
      handle: 'hmark',
    })

    const result = await $.session.compact({ trigger: 'manual', instructions: MARKER, messages: rows as never })
    if ('skip' in result) throw new Error('expected a compaction')
    const messages = result.messages as unknown as { text: string }[]

    expect(messages.length).toBe(rows.length - 1)
    expect(messages.some((row) => row.text.includes(MARKER))).toBe(false)
  })

  test('a history that already breaks tool pairing is left alone', async ($, on) => {
    // The state a session arrives in after its transcript was rewritten a few
    // times: a result whose call is gone. A cut cannot repair it, and rewriting
    // the history would bury the reason the session stopped answering.
    resetState()
    engineUnderTest(on)
    const rows = conversation()
    rows.splice(2, 0, { role: 'user', text: '', toolResults: [{ tool_use_id: 'ghost', text: 'x' }] })

    const result = await $.session.compact({ trigger: 'manual', instructions: MARKER, messages: rows as never })
    if (!('skip' in result)) throw new Error('expected a skip')
    expect(result.skip).toContain('already breaks tool pairing')
  })

  test('a cut that would break tool pairing is dropped, not handed back', async ($, on) => {
    // The `/compact` row is dropped on the way out. Were one ever to carry a
    // result, dropping it would leave its call unanswered — a history the API
    // rejects whole, on that turn and every turn after it.
    resetState()
    engineUnderTest(on)
    const rows = conversation()
    rows.splice(4, 1, {
      role: 'user',
      text: `<command-name>/compact</command-name>\n            <command-args>${MARKER}</command-args>`,
      toolResults: [{ tool_use_id: 'call-1', text: 'ok' }],
    })

    const result = await $.session.compact({ trigger: 'manual', instructions: MARKER, messages: rows as never })
    if (!('skip' in result)) throw new Error('expected a skip')
    expect(result.skip).toContain('would break tool pairing')
  })

  test('a break the replayed view reports does not stop the cut the wire allows', async ($, on) => {
    // The session's own view can hold a call the request does not: this host
    // replays a preserved message past a compaction. Refusing on that reading
    // would strand the session with no cut it is allowed to make.
    resetState()
    const wire = conversation()
    const session = [
      ...wire,
      { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'ghost', tool: 'Bash' }], handle: 'hz' },
    ]
    engineUnderTest(on, { apiRows: () => wire })

    const result = await $.session.compact({ trigger: 'manual', instructions: MARKER, messages: session as never })
    if ('skip' in result) throw new Error('expected a compaction, got: ' + result.skip)
    const messages = result.messages as unknown as CompactedMessages
    expect(messages.some((row) => isCard(row.toolResults?.[0]?.text))).toBe(true)
  })

  test('a break the wire also shows still stops the cut', async ($, on) => {
    // No wire list is on offer: the session's own rows are all there is, and the
    // break they report stands, as it did before the confirmation existed.
    resetState()
    const session = [
      ...conversation(),
      { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'ghost', tool: 'Bash' }], handle: 'hz' },
    ]
    engineUnderTest(on)

    const result = await $.session.compact({ trigger: 'manual', instructions: MARKER, messages: session as never })
    if (!('skip' in result)) throw new Error('expected a skip')
    expect(result.skip).toContain('already breaks tool pairing')
  })

  test('past the gate the conversation is left to the summarizer', async ($, on) => {
    resetState()
    engineUnderTest(on, { tokens: 150_000, threshold: 100_000 })

    const result = await $.session.compact({ trigger: 'manual', instructions: MARKER, messages: conversation() as never })
    expect('skip' in result).toBe(true)
  })
})

describe('the trigger', () => {
  test('below the threshold nothing is asked', async ($, on) => {
    resetState()
    let asked = 0
    engineUnderTest(on, { tokens: 4_000, onCommandRun: () => { asked += 1 } })

    await turn($)
    expect(asked).toBe(0)
  })

  test('above the threshold a compaction carrying the marker is asked for', async ($, on) => {
    resetState()
    const asked: { command: string; args?: string }[] = []
    engineUnderTest(on, { onCommandRun: (input) => { asked.push(input) } })

    await turn($)

    expect(asked.length).toBe(1)
    expect(asked[0]?.command).toBe('compact')
    expect(asked[0]?.args).toBe(MARKER)
  })

  test('a subagent turn is left alone', async ($, on) => {
    resetState()
    let asked = 0
    engineUnderTest(on, { onCommandRun: () => { asked += 1 } })

    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', agentId: 'a1' } as never)
    expect(asked).toBe(0)
  })

  test('a turn that ended on an API error asks for nothing', async ($, on) => {
    // The request that failed is still the history when the turn ends. A cut
    // asked for at that moment rewrites a conversation the engine is already
    // rejecting, so the ask waits for a turn that came back clean.
    resetState()
    let asked = 0
    engineUnderTest(on, { onCommandRun: () => { asked += 1 } })

    await $.turn.complete({ reason: 'error', answer: '', durationMs: 1, isAborted: false, turnId: 't1' } as never)
    await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 1, isAborted: true, turnId: 't2' } as never)
    expect(asked).toBe(0)

    await turn($)
    expect(asked).toBe(1)
  })

  test('a host that reports no fill is asked anyway', async ($, on) => {
    // An embedding host may answer `usage` with no token count and a short
    // `messages`; an ask that finds nothing costs little, and the hook sees the
    // whole conversation, so the mod must not stand down on a missing reading.
    resetState()
    let asked = 0
    engineUnderTest(on, { noReading: true, onCommandRun: () => { asked += 1 } })

    await turn($)
    expect(asked).toBe(1)
  })

  test('after an ask that found nothing the next one waits', async ($, on) => {
    resetState()
    let asked = 0
    engineUnderTest(on, { noReading: true, onCommandRun: () => { asked += 1 } })
    const short = [{ role: 'user', text: 'hi', handle: 'h0' }]

    await turn($)
    expect(asked).toBe(1)

    // The hook's answer is "nothing to cut": the mod backs off.
    const skipped = await $.session.compact({ trigger: 'manual', instructions: MARKER, messages: short as never })
    expect('skip' in skipped).toBe(true)

    // One turn is left alone; the one after it may ask again.
    await turn($)
    expect(asked).toBe(1)

    await turn($)
    expect(asked).toBe(2)
  })

  test('a window with no reported count stands down at 70% of it', async ($, on) => {
    // 512k window, summarizer at 70% (358,400). A turn at 360,000 would only
    // be undone by that summarizer, so nothing is asked.
    resetState()
    let asked = 0
    engineUnderTest(on, { tokens: 360_000, window: 512_000, onCommandRun: () => { asked += 1 } })

    await turn($)
    expect(asked).toBe(0)
  })

  test('below that share the mod still works', async ($, on) => {
    // The same window at 340,000: still inside the range the summarizer leaves
    // alone, so the range is not given away the way half the window gave it.
    resetState()
    let asked = 0
    engineUnderTest(on, { tokens: 340_000, window: 512_000, onCommandRun: () => { asked += 1 } })

    await turn($)
    expect(asked).toBe(1)
  })

  test('the gate sits at 80% of the reported threshold', async ($, on) => {
    // This host's numbers: it reports 479,000 as the count it summarizes at,
    // and fires at 358,400 (70% of its 512k limit). Standing down at 80% of
    // the report — 383,200 — puts the gate behind the fire point instead of
    // 121k past it.
    resetState()
    let asked = 0
    engineUnderTest(on, { tokens: 384_000, window: 1_000_000, threshold: 479_000, onCommandRun: () => { asked += 1 } })

    await turn($)
    expect(asked).toBe(0)
  })

  test('below 80% of the report the mod still works', async ($, on) => {
    resetState()
    let asked = 0
    engineUnderTest(on, { tokens: 380_000, window: 1_000_000, threshold: 479_000, onCommandRun: () => { asked += 1 } })

    await turn($)
    expect(asked).toBe(1)
  })

  test('a turn with nothing old enough to cut is passed over', async ($, on) => {
    // The rows answer with the whole conversation and every round is inside
    // `keepRounds`: asking would only print `Not compacted · …`.
    resetState()
    let asked = 0
    const rows: Row[] = [
      { role: 'user', text: 'go', handle: 'h0' },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Bash' }], handle: 'h1' },
      { role: 'user', text: '', toolResults: [{ tool_use_id: 'a', text: big(12_000) }], handle: 'h2' },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Read' }], handle: 'h3' },
      { role: 'user', text: '', toolResults: [{ tool_use_id: 'b', text: big(12_000) }], handle: 'h4' },
    ]
    engineUnderTest(on, { rows, onCommandRun: () => { asked += 1 } })

    await turn($)
    expect(asked).toBe(0)
  })

  test('a history that already breaks tool pairing is passed over without an ask', async ($, on) => {
    // Asking would run /compact only for the hook to refuse it, and the person
    // reading the transcript would get a `Not compacted` line nothing can fix.
    resetState()
    let asked = 0
    const disk = new Map<string, string>()
    const rows: Row[] = [
      { role: 'user', text: 'go', handle: 'h0' },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Bash' }], handle: 'h1' },
      { role: 'user', text: '', toolResults: [{ tool_use_id: 'ghost', text: big(12_000) }], handle: 'h2' },
      { role: 'user', text: '', toolResults: [{ tool_use_id: 'a', text: big(12_000) }], handle: 'h3' },
    ]
    engineUnderTest(on, { rows, disk, onCommandRun: () => { asked += 1 } })

    await turn($)

    expect(asked).toBe(0)
    const state = disk.get('/home/u/.claude/live-compact/state/s1.json')
    expect(state).toContain('blocked')
    expect(state).toContain('answers no call')
  })

  test('a break the replayed view reports is confirmed against the wire first', async ($, on) => {
    // The session's own view replays a message the host preserved past a
    // compaction, so a result can arrive before the call it answers while the
    // request holds the pair the right way round. Standing down on the replay
    // alone would cost the session every later cut.
    resetState()
    const disk = new Map<string, string>()
    const wire = conversation()
    const replayed = [...wire]
    replayed[1] = wire[2]
    replayed[2] = wire[1]
    engineUnderTest(on, { rows: replayed, apiRows: () => wire, disk })

    await turn($)

    const state = disk.get('/home/u/.claude/live-compact/state/s1.json') ?? ''
    expect(state).not.toContain('blocked')
  })

  test('a break the wire confirms still stands the mod down', async ($, on) => {
    // No wire list is on offer: the session's own rows are all there is, and
    // the break they report stands, as it did before the confirmation existed.
    resetState()
    const disk = new Map<string, string>()
    const wire = conversation()
    const replayed = [...wire]
    replayed[1] = wire[2]
    replayed[2] = wire[1]
    engineUnderTest(on, { rows: replayed, disk })

    await turn($)

    const state = disk.get('/home/u/.claude/live-compact/state/s1.json') ?? ''
    expect(state).toContain('blocked')
  })

  test('a session the summarizer just emptied is passed over without an ask', async ($, on) => {
    // Core's auto-summarizer replaced the conversation with a short tail. The
    // rows are too small to be planned on, but the drop from the last look
    // (200 rows) is the proof there is nothing left of ours to cut: asking
    // would only print a `Not compacted` line.
    resetState()
    let asked = 0
    const disk = new Map<string, string>()
    disk.set(
      '/home/u/.claude/live-compact/state/s1.json',
      JSON.stringify({ turns: 0, cadence: 1, seen: { rows: 200, tokens: 300_000, window: 1_000_000, gate: 650_000 } }),
    )
    const rows: Row[] = [
      { role: 'user', text: 'a compacted summary stands in for the old conversation', handle: 'h0' },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Bash' }], handle: 'h1' },
      { role: 'user', text: '', toolResults: [{ tool_use_id: 'a', text: big(1_500) }], handle: 'h2' },
    ]
    engineUnderTest(on, { rows, disk, onCommandRun: () => { asked += 1 } })

    await turn($)
    expect(asked).toBe(0)
  })

  test('the wait after a cut survives a new process', async ($, on) => {
    // This host runs each turn in a fresh process, so a counter held in a
    // module variable would ask again on the next turn. The wait is on disk.
    resetState()
    let asked = 0
    const disk = new Map<string, string>()
    engineUnderTest(on, { disk, onCommandRun: () => { asked += 1 } })

    const result = await $.session.compact({ trigger: 'manual', instructions: MARKER, messages: conversation() as never })
    if ('skip' in result) throw new Error('expected a compaction')

    // One turn is left alone; the one after it may ask again.
    resetState()
    await turn($)
    expect(asked).toBe(0)

    resetState()
    await turn($)
    expect(asked).toBe(1)
  })

  test('a host that reports no fill keeps waiting on the persisted cadence', async ($, on) => {
    resetState()
    let asked = 0
    const disk = new Map<string, string>()
    engineUnderTest(on, { noReading: true, disk, onCommandRun: () => { asked += 1 } })

    await turn($)
    expect(asked).toBe(1)

    const short = [{ role: 'user', text: 'hi', handle: 'h0' }]
    const skipped = await $.session.compact({ trigger: 'manual', instructions: MARKER, messages: short as never })
    expect('skip' in skipped).toBe(true)

    // A new process still reads the wait the last one recorded: one turn is
    // left alone, the one after it may ask again.
    resetState()
    await turn($)
    expect(asked).toBe(1)

    resetState()
    await turn($)
    expect(asked).toBe(2)
  })
})

describe('the ask that cannot find anything', () => {
  test('a reading with nothing old enough is passed over without an ask', async ($, on) => {
    // The rows are the whole conversation — one finished round, and the newest
    // three are kept verbatim — while the engine reports a 100k context. The
    // plan is empty, so the ask could only print `Not compacted`, and an ask
    // cannot be taken back once it is made: the hook's only answer is a skip.
    resetState()
    let asked = 0
    engineUnderTest(on, {
      rows: [
        { role: 'user', text: 'go' },
        { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c1', tool: 'Bash' }] },
        { role: 'user', text: '', toolResults: [{ tool_use_id: 'c1', text: big(2_000) }] },
        { role: 'user', text: 'and now something else' },
      ] as never,
      tokens: 100_000,
      onCommandRun: () => {
        asked += 1
      },
    })

    await turn($)
    expect(asked).toBe(0)
  })

  test('the state file records what the planner saw', async ($, on) => {
    // A quiet session and a stuck one write the same counters and cut nothing.
    // These numbers are what tells them apart from the state file alone.
    resetState()
    const disk = new Map<string, string>()
    engineUnderTest(on, { tokens: 100_000, disk })

    await turn($)

    const raw = disk.get('/home/u/.claude/live-compact/state/s1.json')
    if (!raw) throw new Error('expected a state file')
    const state = JSON.parse(raw)

    // Four finished rounds before the prompt, none of them kept back by the
    // newest-three rule, and no card in the history yet.
    expect(state.seen.plan.total).toBe(100_000)
    expect(state.seen.plan.rounds).toBe(4)
    expect(state.seen.plan.closed).toBe(4)
    expect(state.seen.plan.candidates).toBe(1)
    expect(state.seen.plan.floor).toBe(-1)
  })
})
