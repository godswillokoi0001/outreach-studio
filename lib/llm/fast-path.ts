/**
 * Conversational fast-path.
 *
 * A greeting does not need the knowledge base, operator memory, tool schemas
 * or a reasoning model. Keeping this classification tiny and pure lets the
 * chat route answer "hi" from the fastest healthy model in about a second.
 */

const GREETING =
  /^(?:hi|hey|hello|yo|hiya|good morning|good afternoon|good evening|howdy|sup|what'?s up|thanks|thank you|thx|cheers|ok|okay|great|cool|nice|perfect|got it|bye|goodbye|see you)\b/i;

const SHORT_QUESTION =
  /^(?:who are you|what can you do|what is this|how do(?:es)? (?:this|it) work|help|are you there)\??$/i;

export function normalizeChatText(raw: string): string {
  return (raw ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`]+|[\s"'`]+$/g, "")
    .trim();
}

/**
 * True for greetings, acknowledgements and a handful of short product
 * questions — the turns that must never wait on retrieval or tools.
 */
export function isTrivialChatTurn(raw: string): boolean {
  const text = normalizeChatText(raw);
  if (!text) return false;
  if (text.length > 80) return false;
  if (GREETING.test(text)) return true;
  if (SHORT_QUESTION.test(text)) return true;
  // "hi there", "hello!", "thanks so much"
  const words = text.replace(/[^\p{L}\s]/gu, "").split(/\s+/).filter(Boolean);
  return words.length <= 3 && /^(?:hi|hey|hello|thanks|thank|ok|okay|great|cool)$/i.test(words[0] ?? "");
}

/**
 * Lean system prompt for the fast path. Deliberately short: no KB dump, no
 * memory, no tool catalogue, so the upstream prompt stays well under 500 tokens.
 */
export function buildFastChatSystemPrompt(input: {
  userName?: string | null;
  currentPath?: string;
  productName?: string;
} = {}): string {
  const name = (input.userName ?? "").trim();
  const product = input.productName ?? "Knowrevo";
  return [
    `You are the ${product} assistant.`,
    name ? `The user is ${name}.` : "",
    input.currentPath ? `They are on ${input.currentPath}.` : "",
    "Answer greetings and short questions in one or two friendly, direct sentences.",
    "Never invent prices, offers, data or actions. If they ask for real workspace work, say you can do it in Agent mode.",
    "No emoji, no filler, no markdown headings.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The last user turn in a plain chat message list, if any. */
export function lastUserText(contents: { role?: string; parts?: { text?: string }[] }[]): string {
  for (let i = contents.length - 1; i >= 0; i -= 1) {
    const turn = contents[i];
    if (turn?.role && turn.role !== "user") continue;
    const text = (turn?.parts ?? [])
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join(" ")
      .trim();
    if (text) return text;
  }
  return "";
}
