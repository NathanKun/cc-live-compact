/**
 * The cut planner: pure functions over a conversation's rows, no `$`, no I/O.
 *
 * Ported from pi-live-compact / dsh-live-compact. The rule that makes the cut
 * cheap is the same in all three: only finished tool results in old rounds are
 * replaced, and everything before the cut keeps the shape (here, the engine's
 * `handle`) it was already sent with, so the prompt cache still reads.
 */

/** The mark a card opens with. Ours, never the engine's `<compacted-summary>`. */
export const CARD_MARK = 'live-compact-checkpoint'

/** Below this many tokens a result is left alone: a card would not pay. */
export const CHUNK_MIN = 1_000

/** At or over this many tokens one result becomes a pointer alone. */
export const POINTER_TOKENS = 32_000

/** Nothing is cut before the conversation is this large. */
export const URGENT_TOKENS = 20_000

/** The newest finished rounds always stay verbatim. */
export const KEEP_ROUNDS = 3

/** At or past this size the engine's own summarizer is left to work. */
export const BIG_GATE = 650_000

/**
 * The share of the count the host reports it summarizes at that the mod stands
 * down at.
 *
 * The reported count is not the fire point — a host compacts at a share of the
 * context limit it is configured with, and it reports a number that is neither
 * that limit nor that point. Measured here: a 512k limit at 70% reports
 * 479,000 and fires at 358,400. A fixed share of the report is the only move
 * left, and 80% keeps the mod just behind the fire point rather than 120k past
 * it. It is a cushion, not a guarantee: a host that compacts at a share below
 * this one still fires first, and the cut is undone with the rest.
 */
export const GATE_SHARE = 0.8

/**
 * Where the mod stands down when the engine reports no summarizer count: this
 * share of the window.
 *
 * Half the window was the earlier guess, and it gave away the range between
 * half and wherever the host really summarizes. The host this was measured on
 * keeps a 512k window and summarizes at 70% of it, so that is the share used
 * for a window the engine describes but does not annotate.
 */
export const NO_REPORT_GATE_SHARE = 0.7

/** The command this mod runs to ask for a compaction in a host that refuses
 * `$.session.compact()`. */
export const COMPACT_COMMAND = 'compact'

/**
 * The instructions this mod puts on that command: the one mark that tells the
 * compaction it asked for from a `/compact` the person typed.
 */
export const MARKER = 'live-compact-cut'

/** What a retry waits when the host refuses a command from inside a hook. */
export const CD_RESUME = 0

/** The first ask of a session waits for nothing: one turn is enough. */
export const CADENCE_FIRST = 1

/**
 * How many turns pass before the mod asks again after a cut landed.
 *
 * Each compaction rewrites the transcript, so asking every turn would trade
 * context for file churn. One turn in between is enough: the cut lives in the
 * same turn it landed on, and the next turn is left alone so a result that
 * arrives right after it is not rewritten twice.
 */
export const CADENCE_AFTER_CUT = 2

/**
 * How many turns pass before asking again after a compaction found nothing.
 *
 * The trigger cannot read the conversation reliably (see `register`), so it
 * asks and lets the compaction hook decide. A "nothing" answer is retried
 * after one turn: a large result can arrive that quickly, and waiting longer
 * leaves context uncut for no gain. The trade is that a stretch with nothing
 * to cut can print a `Not compacted · …` line every other turn.
 */
export const CADENCE_IDLE = 2

/**
 * Whether a row is the `/compact` this mod asked for. The engine records each
 * command run as a row carrying its arguments; those are bookkeeping, so a cut
 * drops them instead of carrying them forward.
 */
export function isTriggerRow(row: Row, marker: string): boolean {
  const text = row.text ?? ''
  return text.includes('<command-name>/compact</command-name>') && text.includes(`<command-args>${marker}`)
}

/** One tool result, as the session hands it over. */
export type Row = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: readonly ToolUse[]
  toolResults?: readonly ToolResult[]
  handle?: string
}

export type ToolUse = {
  tool_use_id: string
  tool: string
  text?: string
  /** The arguments the model gave the call, as the engine hands them over. */
  input?: Record<string, unknown>
  isError?: true
}

export type ToolResult = {
  tool_use_id: string
  text: string
  isError?: boolean
}

/** A result marked for replacement, and the card that takes its place. */
export type Cut = {
  /** The row the result lives in. */
  row: number
  toolUseId: string
  tool: string
  /** The original text, for the shadow copy. */
  text: string
  tokens: number
  pointer: boolean
  card: string
}

/**
 * What the planner saw, kept so the state file can say why a turn was passed
 * over. Without it a quiet session and a stuck one look the same from outside:
 * both write the same `seen` block and cut nothing.
 */
export type PlanStats = {
  /** The size the plan gated on, in tokens. */
  total: number
  /** Finished rounds in the history. */
  rounds: number
  /** Those of them that end before the newest prompt. */
  closed: number
  /** What is left once the newest `keepRounds` are kept verbatim. */
  candidates: number
  /** Candidates refused because they sit at or before the last card. */
  beforeFloor: number
  /** The row holding the newest card, -1 when the history holds none. */
  floor: number
}

export type Plan = {
  cuts: Cut[]
  tokensBefore: number
  tokensAfter: number
  stats: PlanStats
}

export type Limits = {
  urgentTokens: number
  keepRounds: number
  chunkMin: number
  pointerTokens: number
  bigGate: number
}

export const DEFAULT_LIMITS: Limits = {
  urgentTokens: URGENT_TOKENS,
  keepRounds: KEEP_ROUNDS,
  chunkMin: CHUNK_MIN,
  pointerTokens: POINTER_TOKENS,
  bigGate: BIG_GATE,
}

/** Four characters to the token, the estimate the other two ports use. */
export const CHARS_PER_TOKEN = 4

/** What one wide glyph costs. CJK runs at one to two characters per token, so
 * counting it at four to the token reads a Chinese result at a quarter of its
 * weight — a 3,000-character one lands at 750 and `chunkMin` passes it over. */
export const CJK_CHARS_PER_TOKEN = 1.5

/** Whether a code point is written as a wide glyph: Han, kana, hangul, and the
 * fullwidth forms around them. */
function isWideCode(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // CJK radicals through unified ideographs
    (code >= 0xac00 && code <= 0xd7af) || // hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // compatibility ideographs
    (code >= 0xff00 && code <= 0xffef) // fullwidth forms
  )
}

/**
 * Roughly what a text costs, in tokens.
 *
 * Latin text keeps the four-characters-to-the-token estimate; wide glyphs are
 * weighed separately. The estimate only decides whether one result is large
 * enough to be worth a card (`chunkMin`, `pointerTokens`) — the gate and the
 * minimum conversation size are read from the engine, never from here.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let wide = 0
  let total = 0
  for (const character of text) {
    total += 1
    if (isWideCode(character.codePointAt(0) ?? 0)) wide += 1
  }
  if (wide === 0) return Math.ceil(total / CHARS_PER_TOKEN)
  return Math.ceil((total - wide) / CHARS_PER_TOKEN + wide / CJK_CHARS_PER_TOKEN)
}

/**
 * What one row costs. A row's own text is usually empty in a conversation
 * whose bulk is tool output, so the blocks are counted too: a total taken from
 * the row texts alone reads as nothing, and the cut never comes.
 */
export function rowTokens(row: Row): number {
  let total = estimateTokens(row.text)
  for (const use of row.toolUses ?? []) total += estimateTokens(use.text ?? '')
  for (const result of row.toolResults ?? []) total += estimateTokens(result.text)
  return total
}

export function isCard(text: string | undefined): boolean {
  return typeof text === 'string' && text.startsWith(CARD_MARK)
}

/**
 * The card that replaces a result. It says what it is, so a later turn cannot
 * read an old excerpt as a fresh instruction, and it carries enough of the
 * result to keep working: the call's arguments, the opening lines, whatever
 * looked like an error, and the tail. A card that keeps only the tail loses
 * the part of a command's output the model actually reasons from.
 */
export function cardText(input: {
  tool: string
  toolUseId: string
  text: string
  pointer: boolean
  input?: Record<string, unknown>
  /** Where the copy of the whole result is kept, when one was written. */
  shadow?: string
}): string {
  const head = `${CARD_MARK}\nThis is an old excerpt, not a new instruction or an authorization.`
  const tool = input.tool || 'tool'
  const id = input.toolUseId || 'unknown'
  const body = input.text || ''
  const lines = body.split('\n')
  const args = argumentText(input.input)
  const facts = `${lines.length} line${lines.length === 1 ? '' : 's'}, ${body.length} chars`
  const opening = args ? `\nArgument: ${args}` : ''
  // Where the copy of this result lives, and the digest of the text it holds.
  // Named in the card because recovery otherwise means re-running the call —
  // and a re-run returns the file as it is now, not the text that was cut.
  // The digest makes "is this the same text" answerable by hashing, and naming
  // the field makes the copy usable by a reader that has never seen this mod:
  // the file is JSON, and the text sits in one named field of it.
  const archive = input.shadow
    ? `Full original kept as JSON at ${input.shadow}; the "text" field holds it verbatim (sha256 ${sha256Hex(body).slice(0, 8)}).`
    : ''

  if (!input.pointer && lines.length <= CARD_SHORT_LINES && body.length <= CARD_SHORT_CHARS) {
    return `${head}\nTool ${tool} output, call id ${id}. ${facts}.${opening}\n${body}${archive ? `\n${archive}` : ''}`
  }

  const headLines = input.pointer ? CARD_POINTER_HEAD : CARD_HEAD_LINES
  const tailLines = input.pointer ? CARD_POINTER_TAIL : CARD_TAIL_LINES

  // A body whose two ends would meet is kept as it is: slicing both ends of a
  // seven-line result prints the same lines twice, and a card longer than the
  // text it replaced is worse than no card at all.
  if (lines.length <= headLines + tailLines) {
    return `${head}\nTool ${tool} ${input.pointer ? 'result: pointer only' : 'result collapsed'}, call id ${id}. ${facts}.${opening}\n${section(lines)}${archive ? `\n${archive}` : ''}`
  }

  const first = lines.slice(0, headLines)
  const last = lines.slice(-tailLines)
  // The middle by position, not by text: a line the card already shows at
  // either end is not in the middle, and an error line that happens to read
  // like one of them still is.
  const errors = lines
    .slice(headLines, lines.length - tailLines)
    .filter((line) => ERROR_LINE.test(line))
    .slice(0, CARD_ERROR_LINES)

  const parts = [head]
  parts.push(
    input.pointer
      ? `Tool ${tool} result: pointer only, call id ${id}. ${facts}.${opening}`
      : `Tool ${tool} result collapsed, call id ${id}. ${facts}.${opening}`,
  )
  if (first.length > 0) parts.push(`First lines:\n${section(first)}`)
  if (errors.length > 0) parts.push(`Error lines:\n${section(errors)}`)
  if (last.length > 0) parts.push(`Last lines:\n${section(last)}`)
  // The copy first, the advice second: the copy is the exact text, and the
  // advice only points at it. Left the other way round, the advice reads as the
  // way to get the text back and is the one thing that cannot.
  if (archive) parts.push(archive)
  parts.push(archive ? keptCopyText(input.pointer) : recoveryText(tool, input.pointer))
  return parts.join('\n')
}

/**
 * How a card says the dropped text can be had again when a copy was kept.
 *
 * The copy is the text that was cut; a re-run is the file as it is now. For a
 * file that changed in between those are different answers, and the older
 * sentence — "read the same path again" — named the one that is not the text.
 */
export function keptCopyText(pointer: boolean): string {
  const dropped = pointer ? 'The body was dropped here' : 'The middle was dropped here'
  return `${dropped}; the copy named above is the exact text — running the call again returns the file as it is now, not this.`
}

/**
 * How a card says the dropped text can be had again.
 *
 * pi-live-compact varies this by tool, and the difference is real: a `Read` is
 * fetched by naming its path, everything else by making the same call. One
 * generic sentence — "call the tool again" — reads as an instruction to invent
 * a call for a result that came from a file the person already named.
 */
export function recoveryText(tool: string, pointer: boolean): string {
  const dropped = pointer ? 'The body was dropped here' : 'The middle was dropped here'
  switch (tool) {
    case 'Read':
      return `${dropped}; read the same path again if it is needed.`
    case 'Bash':
      return `${dropped}; run the same command again if its output is needed.`
    case 'Grep':
    case 'Glob':
      return `${dropped}; run the same search again if its matches are needed.`
    default:
      return `${dropped}; run the same call again if that output is needed.`
  }
}

/** How much of the call's arguments a card keeps. */
export const CARD_ARG_MAX = 240

/** How much of one kept line a card keeps. */
export const CARD_LINE_MAX = 200

/** The opening lines a collapsed card keeps. */
export const CARD_HEAD_LINES = 6

/** How many lines that look like errors a collapsed card keeps. */
export const CARD_ERROR_LINES = 3

/** The closing lines a collapsed card keeps. */
export const CARD_TAIL_LINES = 8

/** A pointer keeps less of each end: it stands for a result too big to excerpt. */
export const CARD_POINTER_HEAD = 2

export const CARD_POINTER_TAIL = 2

/** A local excerpt is kept whole up to this many lines and characters. */
export const CARD_SHORT_LINES = 12

export const CARD_SHORT_CHARS = 512

/** What counts as an error line worth keeping from the dropped middle. */
const ERROR_LINE = /(^|\W)(error|exception|fatal|failed|failure|traceback|panic)(\W|$)/i

/** One kept line, flattened and clipped: a single runaway line would eat the card. */
function clip(line: string, max = CARD_LINE_MAX): string {
  const flat = line.replace(/\s+$/, '')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function section(lines: readonly string[]): string {
  return lines.map((line) => clip(line)).join('\n')
}

/**
 * The call's arguments, short enough for a card. A Bash command or a path is
 * the useful part of them; the rest of the JSON says little the call's name
 * does not already say.
 */
export function argumentText(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  let text: string
  try {
    text = JSON.stringify(input)
  } catch {
    return ''
  }
  if (!text || text === '{}') return ''
  return text.length > CARD_ARG_MAX ? `${text.slice(0, CARD_ARG_MAX)}…` : text
}

/** One message of the conversation, as the API counts them. */
export type Message = {
  role: 'user' | 'assistant'
  /** Call ids this message makes, in order. */
  calls: string[]
  /** Result ids this message carries, in order. */
  results: string[]
  /** The rows it is made of. */
  rows: number[]
  /** The rows of it that carry a result. */
  resultRows: number[]
}

/**
 * The conversation as messages rather than rows.
 *
 * Hosts do not agree on what one row is. pi and dsh hand one row per message;
 * this host hands one row per content block, so a message with three tool calls
 * arrives as three assistant rows and its three answers as three user rows.
 * The API pairs calls with results at message level and the engine itself
 * merges the rows of one role into one message before sending, so every rule
 * here is applied to a maximal run of one role. On a host that already hands
 * one row per message every run is one row long and nothing changes.
 */
export function messagesOf(rows: readonly Row[]): Message[] {
  const messages: Message[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row) continue
    const calls = (row.toolUses ?? []).map((use) => use.tool_use_id).filter((id) => !!id)
    const results = (row.toolResults ?? []).map((result) => result.tool_use_id).filter((id) => !!id)
    const last = messages.length > 0 ? messages[messages.length - 1] : undefined
    if (last && last.role === row.role) {
      last.calls.push(...calls)
      last.results.push(...results)
      last.rows.push(index)
      if (results.length > 0) last.resultRows.push(index)
      continue
    }
    messages.push({
      role: row.role,
      calls: [...calls],
      results: [...results],
      rows: [index],
      resultRows: results.length > 0 ? [index] : [],
    })
  }
  return messages
}

/** One finished tool round: the call's row and the rows that answered it. */
export type Round = {
  start: number
  end: number
  results: number[]
}

/**
 * The rounds of a conversation. A round opens on an assistant message that calls
 * a tool and takes the user message that carries its results; anything else
 * closes it. `end` is the last row holding a result, never a later row that
 * merely shares its role, so a prompt written right after the results does not
 * pull the round it follows inside the newest prompt.
 */
export function roundsFrom(rows: readonly Row[]): Round[] {
  const rounds: Round[] = []
  let current: Round | null = null
  for (const message of messagesOf(rows)) {
    if (message.role === 'assistant' && message.calls.length > 0) {
      if (current) rounds.push(current)
      const first = message.rows[0] ?? 0
      current = { start: first, end: first, results: [] }
      continue
    }
    if (message.role === 'user' && message.resultRows.length > 0 && current) {
      for (const index of message.resultRows) {
        current.results.push(index)
        if (index > current.end) current.end = index
      }
      continue
    }
    if (current) rounds.push(current)
    current = null
  }
  if (current) rounds.push(current)
  return rounds
}

/** Where the newest prompt sits: the last user row that carries no results. */
export function lastUserIndex(rows: readonly Row[]): number {
  let found = -1
  rows.forEach((row, index) => {
    if (row.role === 'user' && (row.toolResults?.length ?? 0) === 0) found = index
  })
  return found
}

/** Every call id mapped to the tool that made it and the arguments it carried. */
export function toolCalls(rows: readonly Row[]): Map<string, ToolUse> {
  const calls = new Map<string, ToolUse>()
  for (const row of rows) {
    for (const use of row.toolUses ?? []) {
      if (use.tool_use_id) calls.set(use.tool_use_id, use)
    }
  }
  return calls
}

export type SelectOptions = Limits & {
  /** The conversation's size, when the engine knows it. */
  totalTokens: number
  /**
   * Call ids whose result carries an image or a document besides its text.
   * A row holding one is left whole: rebuilding it would rebuild its sibling
   * results from text alone and the engine has no way to put the image back.
   */
  unrebuildable?: ReadonlySet<string>
  /**
   * Where the copy of a cut result is kept, per call id. A card names it, so a
   * reader that has never seen this mod can still reach the original: without
   * the name, recovery means re-running the call, and a re-run returns the
   * file as it is now, not the text that was cut.
   */
  shadowOf?: (toolUseId: string) => string | undefined
}

/**
 * Decides what to cut and what each replacement reads. Nothing is cut below
 * `urgentTokens`, at or past `bigGate`, inside the newest `keepRounds`, before
 * the last card, or in a round the newest prompt opened.
 */
export function selectCuts(rows: readonly Row[], options: SelectOptions): Plan {
  const estimated = rows.reduce((sum, row) => sum + rowTokens(row), 0)
  const total = Number.isFinite(options.totalTokens) && options.totalTokens > 0 ? options.totalTokens : estimated
  const stats: PlanStats = { total, rounds: 0, closed: 0, candidates: 0, beforeFloor: 0, floor: -1 }
  const before = { cuts: [] as Cut[], tokensBefore: total, tokensAfter: total, stats }

  if (total < options.urgentTokens || total >= options.bigGate) return before

  const floor = rows.reduce((found, row, index) => {
    const card =
      isCard(row.text) ||
      (row.toolResults ?? []).some((result) => isCard(result.text)) ||
      (row.toolUses ?? []).some((use) => isCard(use.text))
    return card ? index : found
  }, -1)
  stats.floor = floor

  const calls = toolCalls(rows)
  const userAt = lastUserIndex(rows)
  const finished = roundsFrom(rows).filter((round) => round.results.length > 0)
  const closed = userAt < 0 ? finished : finished.filter((round) => round.end < userAt)
  const keep = Math.max(0, options.keepRounds)
  const candidates = closed.slice(0, Math.max(0, closed.length - keep))
  stats.rounds = finished.length
  stats.closed = closed.length
  stats.candidates = candidates.length
  stats.beforeFloor = candidates.filter((round) => round.end <= floor).length

  const cuts: Cut[] = []
  for (const round of candidates) {
    if (round.end <= floor) continue

    // A round that holds a long `Read` is cut for that result alone: the read
    // is what it was for, the rest of the round is the reasoning around it.
    const longRead = round.results.some((index) => {
      const row = rows[index]
      return (row?.toolResults ?? []).some((result) => {
        const tool = calls.get(result.tool_use_id)?.tool ?? ''
        return tool === 'Read' && estimateTokens(result.text) >= options.chunkMin
      })
    })

    for (const index of round.results) {
      if (index <= floor) continue
      const row = rows[index]
      if (!row) continue
      // A row is rebuilt whole or not at all, and a rebuilt row speaks through
      // its text blocks alone. So one result carrying an image or a document
      // locks its neighbours in the same row too: cutting them would drop it.
      const locked = (row.toolResults ?? []).some((result) =>
        options.unrebuildable?.has(result.tool_use_id),
      )
      if (locked) continue
      for (const result of row.toolResults ?? []) {
        if (!result.tool_use_id) continue
        if (isCard(result.text) || result.isError === true) continue
        const tokens = estimateTokens(result.text)
        if (tokens < options.chunkMin) continue
        const call = calls.get(result.tool_use_id)
        const tool = call?.tool ?? ''
        if (longRead && tool !== 'Read') continue
        const pointer = tokens >= options.pointerTokens
        cuts.push({
          row: index,
          toolUseId: result.tool_use_id,
          tool,
          text: result.text,
          tokens,
          pointer,
          card: cardText({
            tool,
            toolUseId: result.tool_use_id,
            text: result.text,
            pointer,
            input: call?.input,
            shadow: options.shadowOf?.(result.tool_use_id),
          }),
        })
      }
    }
  }

  if (cuts.length === 0) return before

  const saved = cuts.reduce((sum, cut) => sum + cut.tokens - estimateTokens(cut.card), 0)
  return { cuts, tokensBefore: total, tokensAfter: Math.max(0, total - saved), stats }
}

/**
 * Hands back the conversation with each cut applied. A row a cut landed in
 * loses its `handle`, so the engine reads it as built — which is the whole
 * cost of the cut, paid at the tail alone; rows before it keep theirs.
 */
export function applyCuts(rows: readonly Row[], cuts: readonly Cut[]): Row[] {
  const byRow = new Map<number, Cut[]>()
  for (const cut of cuts) {
    const list = byRow.get(cut.row)
    if (list) list.push(cut)
    else byRow.set(cut.row, [cut])
  }

  return rows.map((row, index) => {
    // Every row handed back carries its tool list, empty where it has none:
    // the engine reads the blocks from that list, and a missing one is not a
    // row it will build again.
    const base: Row = { ...row, toolUses: row.toolUses ?? [] }

    const list = byRow.get(index)
    if (!list) return base

    const cards = new Map(list.map((cut) => [cut.toolUseId, cut.card]))
    // `handle` is the only field dropped, and dropping it is the point: it is
    // what tells the engine the row was already sent. Everything else the row
    // carries — `agentId` today, and whatever the engine adds next — is kept.
    // Enumerating the fields here would silently lose them on exactly the rows
    // this mod rewrites, and only on those.
    const rebuilt: Row = {
      ...base,
      toolResults: (base.toolResults ?? []).map((result) => {
        const card = cards.get(result.tool_use_id)
        return card === undefined ? result : { ...result, text: card }
      }),
    }
    delete rebuilt.handle
    return rebuilt
  })
}

/**
 * The first way a list of rows cannot be sent, or null when it can.
 *
 * The API pairs every `tool_use` with a `tool_result` in the message right
 * after the one that made the call, and a history that breaks that pairing is
 * rejected whole — the engine reports it as `tool_history_mismatch`, which the
 * person reads as `API Error: 400 due to tool use concurrency issues`. It is
 * the one failure that does not pass with the next turn: the broken history is
 * still there, so every retry sends it and fails the same way.
 *
 * Two shapes break it, and both turn up in a history a mod has rewritten a few
 * times: a call left unanswered, and a result that answers no call before it.
 * A repeated id alone does not: this host replays a preserved message past a
 * compaction, so the same call legitimately appears twice, answered twice.
 *
 * It is read at message level (see `messagesOf`): one assistant message may make
 * several calls at once and the user message right after it answers them all,
 * so a run of call rows is one message, not several calls gone unanswered.
 *
 * A cut must never be the thing that produces one of them, so the hook asks
 * here first and drops the cut when the answer is not null. It is also the only
 * cheap way to notice that a session arrived broken: a cut cannot repair that,
 * and pretending otherwise only hides it.
 */
export function pairingProblem(rows: readonly Row[]): string | null {
  /**
   * Calls made and not yet answered, by id.
   *
   * A history may hold the same call id more than once: this host replays a
   * preserved message past a compaction, so the same assistant message arrives
   * twice, at the two positions, with its results both times. What the API
   * rejects is a call left unanswered, or a result answering no call before it
   * — so counts are what is checked, not whether an id has been seen.
   */
  const outstanding = new Map<string, number>()

  for (const message of messagesOf(rows)) {
    const at = message.rows[0] ?? 0

    if (message.calls.length > 0) {
      // A new message that calls closes the previous one: its result had to be
      // in the message in between.
      for (const [id, count] of outstanding) {
        if (count > 0) return `row ${at}: call ${id} has no result before the next call`
      }
      for (const id of message.calls) outstanding.set(id, (outstanding.get(id) ?? 0) + 1)
    }

    for (const id of message.results) {
      const waiting = outstanding.get(id) ?? 0
      if (waiting === 0) return `row ${at}: result ${id} answers no call before it`
      outstanding.set(id, waiting - 1)
    }
  }

  for (const [id, count] of outstanding) {
    if (count > 0) return `tail: call ${id} has no result`
  }
  return null
}

/** The `~/.claude/live-compact/shadow/<session>/<call-id>.json` a cut is kept in. */
export function shadowPath(home: string, sessionId: string, toolUseId: string): string {
  const safeSession = sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || 'session'
  const safeId = toolUseId.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown'
  const root = home.replace(/[\\/]+$/, '')
  return `${root}/.claude/live-compact/shadow/${safeSession}/${safeId}.json`
}

/**
 * What a shadow file holds: the original result, and the digest that proves a
 * later reader got that same text back. The shape is pi-live-compact's.
 */
export type ShadowRecord = {
  toolUseId: string
  tool: string
  chars: number
  sha256: string
  text: string
}

/** The record to keep for one cut. */
export function shadowRecord(input: { tool: string; toolUseId: string; text: string }): ShadowRecord {
  return {
    toolUseId: input.toolUseId,
    tool: input.tool,
    chars: input.text.length,
    sha256: sha256Hex(input.text),
    text: input.text,
  }
}

/** The record a shadow file holds, or null when the file is not one of ours. */
export function shadowRead(raw: string): ShadowRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ShadowRecord> | null
    if (!parsed || typeof parsed.text !== 'string' || typeof parsed.sha256 !== 'string') return null
    return parsed as ShadowRecord
  } catch {
    return null
  }
}

/**
 * Whether a shadow file still holds exactly this result: the text did not
 * change under the digest, and the digest is of the text that was cut.
 */
export function shadowHolds(record: ShadowRecord, text: string): boolean {
  return record.text === text && record.sha256 === sha256Hex(record.text)
}

/** SHA-256 as lowercase hex.
 *
 * pi-live-compact hashes with `node:crypto`. This is written out instead: a
 * hook module loads inside the engine's own process, and an import the loader
 * refuses would take the whole mod — every ask, every card — down with it. The
 * shape of the record stays the one pi writes, so a shadow reads the same
 * either way.
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const blocks = Math.floor((bytes.length + 9 + 63) / 64)
  const padded = new Uint8Array(blocks * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  const bits = bytes.length * 8
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000))
  view.setUint32(padded.length - 4, bits >>> 0)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  const rotr = (value: number, by: number): number => ((value >>> by) | (value << (32 - by))) >>> 0

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]
      const y = w[i - 2]
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = h[0]
    let b = h[1]
    let c = h[2]
    let d = h[3]
    let e = h[4]
    let f = h[5]
    let g = h[6]
    let k = h[7]
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (k + s1 + ch + SHA256_K[i] + w[i]) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) >>> 0
      k = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + k) >>> 0
  }

  let out = ''
  for (const word of h) out += word.toString(16).padStart(8, '0')
  return out
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
