import type { EngineInterface, Register } from 'claude-code'
import {
  applyCuts,
  isTriggerRow,
  pairingProblem,
  rowTokens,
  selectCuts,
  shadowHolds,
  shadowPath,
  shadowRead,
  shadowRecord,
  CADENCE_AFTER_CUT,
  CADENCE_FIRST,
  CADENCE_IDLE,
  BIG_GATE,
  CHUNK_MIN,
  COMPACT_COMMAND,
  GATE_SHARE,
  KEEP_ROUNDS,
  MARKER,
  NO_REPORT_GATE_SHARE,
  POINTER_TOKENS,
  URGENT_TOKENS,
  type Cut,
  type Limits,
  type PlanStats,
  type Row,
} from './plan'

type Options = Readonly<Record<string, string | number | boolean | readonly string[]>>

/**
 * What the last turn read, kept beside the counters so a later look can say
 * why a turn was passed over without the mod having to log anything.
 */
type Seen = {
  tokens?: number
  window: number
  gate: number
  rows?: number
  rowTokens?: number
  /** What the planner saw on this turn, so a quiet session and a stuck one can
   * be told apart from the state file alone. */
  plan?: PlanStats
}

/**
 * The counters live on disk, not in a module variable: a host may run each
 * turn in a fresh process (`--resume … --fork-session`), and a variable that
 * resets every turn would make the waits meaningless — the mod would ask
 * every turn and the person would read a `Not compacted · …` line every turn.
 */
type State = {
  /** Turns since the last ask. */
  turns: number
  /** How many turns to wait between asks. */
  cadence: number
  seen?: Seen
  /** The row counts around the last cut, kept as the observable record of it. */
  cut?: { before: number; after: number }
  /** Why the last look found the history uncuttable, when it did. */
  blocked?: string
}

const FRESH: State = { turns: 0, cadence: CADENCE_FIRST }

/**
 * When the ask in flight started, or 0 when none is.
 *
 * A plain boolean was the first shape, and it had a failure mode with no way
 * back: `finally` only runs when the await settles, so a host that queues the
 * command instead of running it left the flag up for the life of the process —
 * every later turn returned at the gate, nothing was written, and the mod
 * simply stopped without a trace. A timestamp can go stale on its own.
 */
let busySince = 0

/** How long one ask may hold the process before it is treated as lost. Longer
 * than any compaction measured here, short enough that the next turn can try
 * again rather than wait for a restart. */
export const BUSY_STALE_MS = 120_000

function busyNow(): boolean {
  return busySince !== 0 && Date.now() - busySince < BUSY_STALE_MS
}

/** Back to the start, for a harness that runs many sessions in one process. */
export function resetState(): void {
  busySince = 0
}

function numberOption(options: Options, key: string, fallback: number): number {
  const value = options[key]
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function booleanOption(options: Options, key: string, fallback: boolean): boolean {
  const value = options[key]
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

async function homeOf($: EngineInterface): Promise<string | undefined> {
  try {
    return (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? undefined
  } catch {
    return undefined
  }
}

/** `~/.claude/live-compact/state/<session>.json`, or null without a home. */
async function statePathOf($: EngineInterface): Promise<string | null> {
  const home = await homeOf($)
  if (!home) return null
  let sessionId = 'session'
  try {
    sessionId = await $.session.id()
  } catch {
    // The default is a valid folder name; the counters may still stand.
  }
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || 'session'
  return `${home.replace(/[\\/]+$/, '')}/.claude/live-compact/state/${safe}.json`
}

async function loadState($: EngineInterface): Promise<State> {
  const path = await statePathOf($)
  if (!path) return { ...FRESH }
  try {
    const parsed = JSON.parse(await $.fs.read(path)) as Partial<State>
    const turns =
      typeof parsed.turns === 'number' && Number.isFinite(parsed.turns) && parsed.turns >= 0 ? parsed.turns : 0
    const cadence =
      typeof parsed.cadence === 'number' && Number.isFinite(parsed.cadence) && parsed.cadence > 0
        ? parsed.cadence
        : CADENCE_FIRST
    const cut =
      parsed.cut &&
      typeof parsed.cut.before === 'number' &&
      typeof parsed.cut.after === 'number'
        ? { before: parsed.cut.before, after: parsed.cut.after }
        : undefined
    const blocked = typeof parsed.blocked === 'string' ? parsed.blocked : undefined
    return { turns, cadence, seen: parsed.seen, cut, blocked }
  } catch {
    // No file yet, or an unreadable one: start the way a first turn does.
    return { ...FRESH }
  }
}

async function saveState($: EngineInterface, state: State): Promise<void> {
  const path = await statePathOf($)
  if (!path) return
  try {
    await $.fs.write(path, JSON.stringify(state))
  } catch {
    // Not kept: the next turn starts fresh rather than failing the turn.
  }
}

type Reading = {
  /** Input tokens of the last response; 0 when the host has no reading. */
  tokens: number
  /** The model's window in tokens; 0 when unknown. */
  window: number
  /** The count at which the engine summarizes, when it reports one. */
  threshold: number | null
}

/**
 * What the host says about the window. `breakdown: "summary"` estimates
 * locally and sends nothing, and is the only place the engine reports the
 * count its own summarizer fires at.
 */
async function readingOf($: EngineInterface): Promise<Reading> {
  const reading: Reading = { tokens: 0, window: 0, threshold: null }
  try {
    const context = (await $.session.usage({ breakdown: 'summary' })).context
    if (typeof context.tokens === 'number' && Number.isFinite(context.tokens) && context.tokens > 0) {
      reading.tokens = context.tokens
    }
    if (typeof context.window === 'number' && Number.isFinite(context.window) && context.window > 0) {
      reading.window = context.window
    }
    const threshold = context.breakdown?.autoCompactThreshold
    if (typeof threshold === 'number' && Number.isFinite(threshold) && threshold > 0) reading.threshold = threshold
  } catch {
    // No reading: the mod asks on its cadence and the hook decides.
  }
  return reading
}

/**
 * Where this mod stands down: `GATE_SHARE` of the count the engine reports it
 * summarizes at, or `NO_REPORT_GATE_SHARE` of the window when the engine
 * reports no count. Past that the summarizer is about to replace the
 * conversation anyway, so a cut would be undone.
 *
 * The share is there because the reported count is not the fire point: a host
 * compacts at a share of the context limit it is configured with. Measured
 * here, a 512k limit at 70% reports 479,000 and fires at 358,400 — the 80%
 * share puts the gate at 383,200 instead of 479,000, which is 25k past the
 * fire point rather than 121k past it. `bigGate` remains the hard ceiling.
 */
function gateOf(reading: Reading, gate: number): number {
  const ceiling = reading.threshold
    ? Math.floor(reading.threshold * GATE_SHARE)
    : reading.window > 0
      ? Math.floor(reading.window * NO_REPORT_GATE_SHARE)
      : 0
  return ceiling > 0 ? Math.min(gate, ceiling) : gate
}

/**
 * Whether a break the session's own view reports is only the replay's ordering.
 *
 * The host replays a message it preserved past a compaction, so that view can
 * hold a result before the call it answers. The list the engine sends carries
 * each pair the right way round. A break the wire list also shows is real; one
 * it does not show is the replay's, and standing down on it would refuse every
 * cut this session has left. A host that cannot produce the wire list is taken
 * at its word, as before.
 */
async function replayOrdering($: EngineInterface, rows: readonly Row[]): Promise<boolean> {
  const wire = await rowsOf($, 'api')
  if (!wire) return false
  return pairingProblem(wire) === null && pairingProblem(rows) !== null
}

/** The call and result ids a list holds, whichever order the replay put them in. */
function pairSignature(rows: readonly Row[]): string {
  const calls: string[] = []
  const results: string[] = []
  for (const row of rows) {
    for (const use of row.toolUses ?? []) calls.push(use.tool_use_id)
    for (const result of row.toolResults ?? []) results.push(result.tool_use_id)
  }
  calls.sort()
  results.sort()
  return `${calls.join(',')}|${results.join(',')}`
}

/** The session's own rows, or null when the host answers with none.
 *
 * `as: 'api'` asks for the list the engine puts on the wire. The two are not
 * the same list: this host replays a preserved message past a compaction, so
 * the session's own view can hold a call and its result in the other order,
 * while the request carries each pair the right way round. Only the wire list
 * says what the API would accept.
 */
async function rowsOf($: EngineInterface, as?: 'api'): Promise<Row[] | null> {
  try {
    const rows = as === 'api' ? await $.session.messages({ as }) : await $.session.messages()
    return Array.isArray(rows) && rows.length > 0 ? (rows as unknown as Row[]) : null
  } catch {
    return null
  }
}

/**
 * The call ids whose result carries an image or a document beside its text.
 * The engine rebuilds a row it is handed back from `role`, `text` and its tool
 * blocks alone, so a result like that cannot be replaced with a card without
 * dropping what it holds. The plan leaves its whole row whole.
 */
async function unrebuildableResultIds($: EngineInterface, agentId?: string): Promise<Set<string>> {
  const found = new Set<string>()
  try {
    const api = agentId === undefined
      ? await $.session.messages({ as: 'api' })
      : await $.session.messages({ as: 'api', agentId })
    if (!Array.isArray(api)) return found
    for (const message of api) {
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const typed = block as { type?: string; tool_use_id?: string; content?: unknown }
        if (typed.type !== 'tool_result' || !typed.tool_use_id) continue
        const inner = typed.content
        if (
          Array.isArray(inner) &&
          inner.some((part) => {
            const kind = (part as { type?: string } | null)?.type
            return typeof kind === 'string' && kind !== 'text'
          })
        ) {
          found.add(typed.tool_use_id)
        }
      }
    }
  } catch {
    // No API form to read: the rows are used as given.
  }
  return found
}

/**
 * The path each call's copy goes to, with the session's folder resolved once.
 * The same function names the copy inside the card, so a card always points at
 * the file its own cut wrote — never at a guess.
 */
async function shadowResolverOf($: EngineInterface): Promise<(toolUseId: string) => string | undefined> {
  const home = await homeOf($)
  if (!home) return () => undefined
  let sessionId = 'session'
  try {
    sessionId = await $.session.id()
  } catch {
    // The default is a valid folder name; the cut may still stand.
  }
  return (toolUseId: string) => shadowPath(home, sessionId, toolUseId)
}

/**
 * Keeps each original under the shadow root before its card stands. A cut
 * whose text could not be kept is dropped and its result stays as it was.
 *
 * The file is a record, not the bare text: `toolUseId`, `tool`, `chars`, the
 * SHA-256 of the text, and the text itself — pi-live-compact's shape. The
 * digest is what makes the promise checkable from outside; a person who opens
 * a shadow can hash it and learn whether the copy is the one that was cut.
 *
 * A write is read back before its cut stands. pi gets atomicity from a
 * tmp-file rename; `$.fs` here offers no rename, so the same guarantee is
 * bought the other way round: whatever did not read back as this very text is
 * treated as not kept, and that result stays whole in the history.
 */
async function backUp(
  $: EngineInterface,
  cuts: readonly Cut[],
  shadowOf: (toolUseId: string) => string | undefined,
): Promise<Cut[]> {
  if (cuts.length === 0) return []

  const kept: Cut[] = []
  for (const cut of cuts) {
    const path = shadowOf(cut.toolUseId)
    if (!path) continue
    try {
      // A shadow already holding this exact text is left as it is: the same
      // result cut twice — a session resumed and cut again — must not rewrite
      // the record its first card points at.
      if (await $.fs.exists(path)) {
        const held = shadowRead(await $.fs.read(path))
        if (held && shadowHolds(held, cut.text)) {
          kept.push(cut)
          continue
        }
      }
      await $.fs.write(path, JSON.stringify(shadowRecord(cut)))
      const back = shadowRead(await $.fs.read(path))
      if (!back || !shadowHolds(back, cut.text)) continue
      kept.push(cut)
    } catch {
      // Not kept: leave that result alone.
    }
  }
  return kept
}

/**
 * Asks the engine for a compaction the way the person would: `/compact` with
 * this mod's marker as its instructions.
 *
 * `$.session.compact()` is the direct route, and in a headless (-p / SDK) host
 * — every session an embedding application runs — the engine refuses it:
 *
 *   HooksError: $.session.compact: not available in a headless (-p / SDK)
 *   session yet: compaction here runs inside a turn (a /compact prompt)
 *
 * `$.command.run` runs `/compact` as a prompt instead, which those hosts do
 * allow; the event that comes back is `session.compact` with `manual`, and the
 * marker tells this mod's ask from a person's own `/compact`.
 */
async function queueCompact($: EngineInterface): Promise<void> {
  try {
    await $.command.run({ command: COMPACT_COMMAND, args: MARKER })
  } catch {
    // The host may refuse a command asked from inside a hook the turn waits
    // on: ask again once the turn is out and the session is idle.
    try {
      $.clock.after(0, () => {
        void $.command.run({ command: COMPACT_COMMAND, args: MARKER }).catch(() => undefined)
      })
    } catch {
      // Nothing else to try: a cut is an optimisation, not a repair.
    }
  }
}

/**
 * Consider a cut once a turn is out.
 *
 * Three gates, cheapest first: the host's own reading of the window (stand
 * down below `minTokens` and at the count the engine summarizes at), the
 * session's rows when the host answers with them (a turn with nothing old
 * enough to cut is passed over silently), and the cadence on disk.
 *
 * The rows are what keeps the person from reading a `Not compacted · …` line
 * on every turn, so they are consulted whenever they are big enough to be the
 * conversation rather than the tail some hosts answer with.
 */
async function attemptCut(
  $: EngineInterface,
  limits: Limits,
  enabled: boolean,
): Promise<void> {
  if (!enabled || busyNow()) return

  const state = await loadState($)
  state.turns += 1
  // Whatever the last look could not cut is re-read on this one.
  state.blocked = undefined

  const reading = await readingOf($)
  const gate = gateOf(reading, limits.bigGate)
  const previous = state.seen
  // The row counts carry over instead of being rebuilt empty: a turn whose rows
  // could not be read would otherwise erase what the last one measured, and the
  // state file would read as a session that never had any history.
  state.seen = {
    tokens: reading.tokens > 0 ? reading.tokens : undefined,
    window: reading.window,
    gate,
    rows: previous?.rows,
    rowTokens: previous?.rowTokens,
  }

  if (reading.tokens > 0 && (reading.tokens < limits.urgentTokens || reading.tokens >= gate)) {
    await saveState($, state)
    return
  }

  const rows = await rowsOf($)
  if (rows) {
    const total = rows.reduce((sum, row) => sum + rowTokens(row), 0)
    state.seen.rows = rows.length
    state.seen.rowTokens = total
    // A cut cannot repair a history that already breaks tool pairing, and the
    // hook refuses one asked on it. Asking anyway only prints a `Not compacted`
    // line nothing in the mod can fix, so the ask is not made — whatever the
    // rows add up to, and whether or not anything in them would be cut.
    //
    // A break read here is a claim, not a fact. The session's own view replays
    // a message the host preserved past a compaction, so a call can arrive
    // after its own result, and standing down on that reading alone would cost
    // the session every later cut. So the break is confirmed against the list
    // the engine sends before the mod stops asking; a host that cannot produce
    // that list is answered by the session's own rows, as before. The second
    // read only happens on a turn that already looks broken.
    const sessionBroken = pairingProblem(rows)
    const broken = sessionBroken ? pairingProblem((await rowsOf($, 'api')) ?? rows) : null
    if (broken) {
      state.blocked = broken
      await saveState($, state)
      return
    }
    // The same rule the compaction hook applies, read from the same numbers.
    // This used to be gated on the rows' own token total while `selectCuts`
    // gates on the engine's count, and the two disagree by the system prompt —
    // 100k of context against 18k of rows on the host this was measured on. A
    // turn could then pass the pre-flight with nothing to cut, make the ask,
    // and read `Not compacted`; once made, the ask cannot be taken back.
    //
    // The plan is computed either way, and recorded either way. It only keeps
    // the ask from being made when the engine gave a reading: without one there
    // is no way to tell a whole history from the tail of one, and standing down
    // on rows that might be a tail would mean never cutting at all. With a
    // reading, an empty plan can only mean the ask prints `Not compacted`.
    const plan = selectCuts(rows, { ...limits, totalTokens: reading.tokens })
    state.seen.plan = plan.stats
    if (reading.tokens > 0 && plan.cuts.length === 0) {
      await saveState($, state)
      return
    }
  }

  if (state.turns < state.cadence) {
    await saveState($, state)
    return
  }

  state.turns = 0
  await saveState($, state)
  busySince = Date.now()
  try {
    await queueCompact($)
  } finally {
    busySince = 0
  }
}

/** Records what the next ask has to wait, on disk so a new process keeps it. */
async function setCadence($: EngineInterface, cadence: number): Promise<void> {
  const state = await loadState($)
  state.cadence = cadence
  state.turns = 0
  await saveState($, state)
}

/** Records the size before and after the cut, for the next read to check. */
async function setCut($: EngineInterface, before: number, after: number): Promise<void> {
  const state = await loadState($)
  state.cut = { before, after }
  state.turns = 0
  await saveState($, state)
}

export const register: Register = (on, options) => {
  const enabled = booleanOption(options, 'enabled', true)
  const limits: Limits = {
    urgentTokens: numberOption(options, 'minTokens', URGENT_TOKENS),
    keepRounds: numberOption(options, 'keepRounds', KEEP_ROUNDS),
    chunkMin: numberOption(options, 'chunkMin', CHUNK_MIN),
    pointerTokens: numberOption(options, 'pointerTokens', POINTER_TOKENS),
    bigGate: numberOption(options, 'bigGate', BIG_GATE),
  }

  // ── The cut ───────────────────────────────────────────────────────────────
  // The compaction this mod asked for, and only that one: a person's own
  // `/compact` still goes to core's summarizer, untouched.
  on('session.compact', { trigger: 'manual' }, async ($, e, next) => {
    // Anyone else's `/compact` — the person's, another plugin's — is not ours.
    if (e.instructions !== MARKER) return next(e)

    const rows = e.messages as unknown as readonly Row[]
    const reading = await readingOf($)
    const gate = gateOf(reading, limits.bigGate)

    // The stand-down promise, read here as well as at the ask: the hook sees
    // the engine's current reading even when the trigger did not.
    if (reading.tokens > 0) {
      if (reading.tokens < limits.urgentTokens) {
        await setCadence($, CADENCE_IDLE)
        return { skip: 'live-compact: conversation below minTokens' }
      }
      if (reading.tokens >= gate) {
        await setCadence($, CADENCE_IDLE)
        return { skip: 'live-compact: past bigGate, the summarizer has it' }
      }
    }

    // A history that already breaks tool pairing cannot be repaired by a cut,
    // and rewriting it would only bury the reason the session stopped answering.
    // The session's own view replays a preserved message, so a call can arrive
    // after its own result there; when that is all that is wrong, the wire list
    // is still whole and the cut goes ahead.
    const incoming = pairingProblem(rows)
    const replayed = incoming ? await replayOrdering($, rows) : false
    if (incoming && !replayed) {
      await setCadence($, CADENCE_IDLE)
      return { skip: `live-compact: the session's history already breaks tool pairing (${incoming})` }
    }

    const shadowOf = await shadowResolverOf($)
    const plan = selectCuts(rows, {
      ...limits,
      totalTokens: reading.tokens,
      unrebuildable: await unrebuildableResultIds($, e.agentId),
      // The card names the copy, so a reader that never saw this mod can still
      // open the original instead of re-running a call.
      shadowOf,
    })
    if (plan.cuts.length === 0) {
      // A skip, never `next`: the summarizer must not be handed our marker as
      // an instruction to rewrite the conversation with.
      await setCadence($, CADENCE_IDLE)
      return { skip: 'live-compact: nothing finished to cut' }
    }

    const kept = await backUp($, plan.cuts, shadowOf)
    if (kept.length === 0) {
      await setCadence($, CADENCE_IDLE)
      return { skip: 'live-compact: originals could not be kept' }
    }

    await setCadence($, CADENCE_AFTER_CUT)

    // The `/compact` rows this mod asked for are dropped: they are bookkeeping,
    // not conversation, and one lands on every cut.
    const messages = applyCuts(rows, kept).filter((row) => !isTriggerRow(row, MARKER))

    // The list about to be handed back, checked against the same rule the API
    // enforces: a run of cuts that ended in an unanswered call would cost the
    // person the session, not a few tokens, so a cut that cannot be handed back
    // whole is no cut at all.
    //
    // A cut replaces text in place and drops the trigger rows alone, so the
    // pairs it hands back are the ones it was given. When the break it came in
    // with was the replay's ordering, the same break on the way out is not a
    // new one — the signature proves nothing was added or removed.
    const outgoing = pairingProblem(messages)
    if (outgoing && !(replayed && pairSignature(rows) === pairSignature(messages))) {
      await setCadence($, CADENCE_IDLE)
      return { skip: `live-compact: rebuilt history would break tool pairing (${outgoing})` }
    }

    await setCut($, rows.length, messages.length)

    // No `tokensBefore`/`tokensAfter`: the engine measures the list it is given,
    // and a hook's own figures have been seen to land beside that measure rather
    // than in place of it, which reads as a conversation twice the size.
    return { messages: messages as unknown as typeof e.messages }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // A turn that ended on an API error or an interrupt leaves the request that
    // failed still in the history; asking for a compaction right then rewrites
    // a conversation the engine is already unhappy with. Wait for a clean turn.
    if (e.reason === 'error' || e.reason === 'aborted') return next(e)
    await attemptCut($, limits, enabled)
    return next(e)
  })
}
