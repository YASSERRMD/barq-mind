// Centralized prompt templates. Every export is a pure function that returns
// a fully formatted message array ready for InferenceEngine.chat(). No side
// effects, no business logic.

const SUMMARY_SYSTEM = "You are a careful technical summarizer. Produce concise, factual summaries strictly grounded in the provided text. Do not invent details. Do not add framing language.";

function joinChildContext(childContext) {
  if (!childContext || !childContext.length) return "(none)";
  return childContext
    .map((c, i) => `${i + 1}. ${c.title}: ${c.snippet}`)
    .join("\n");
}

export function promptRoutingSummary(node, childContext) {
  const children = joinChildContext(childContext);
  return [
    { role: "system", content: SUMMARY_SYSTEM },
    {
      role: "user",
      content:
        `Write a routing summary of the following section, suitable for a table of contents entry. ` +
        `Target 1 to 3 sentences, around 50 tokens. The summary helps a navigator decide whether to descend into this section.\n\n` +
        `Section title: ${node.title}\n` +
        `Section level: ${node.level}\n\n` +
        `Children (with brief snippets):\n${children}\n\n` +
        `Return only the summary text. No quotes, no preface.`,
    },
  ];
}

export function promptFullSummary(node, childContext, fullText) {
  const hasFullText = typeof fullText === "string" && fullText.length > 0;
  const userBody = hasFullText
    ? `Section title: ${node.title}\nSection level: ${node.level}\n\nFull text:\n${fullText.slice(0, 6000)}`
    : `Section title: ${node.title}\nSection level: ${node.level}\n\nChildren (with snippets):\n${joinChildContext(childContext)}`;
  return [
    { role: "system", content: SUMMARY_SYSTEM },
    {
      role: "user",
      content:
        `Write a chapter-style summary of the following ${hasFullText ? "leaf" : "section"}. ` +
        `Target 200 to 300 tokens. Cover scope, key claims, and notable specifics. Stay strictly within the source.\n\n` +
        `${userBody}\n\n` +
        `Return only the summary text. No headings, no bullet lists.`,
    },
  ];
}

export const NAVIGATE_SYSTEM =
  "You are a document navigation agent. Given a user question and a list of candidate " +
  "sections (with IDs and short summaries), pick the next action. You must respond with " +
  "a single JSON object and nothing else. Schema:\n" +
  "{action: 'descend', child_ids: [string], reason: string}\n" +
  "or {action: 'select_leaves', leaf_ids: [string], reason: string}\n" +
  "or {action: 'bm25_fallback', query_terms: [string], reason: string}\n" +
  "or {action: 'widen', reason: string}.\n" +
  "Only use child_ids/leaf_ids that appear in the candidate list. Reason must be one short sentence.";

function formatCurrentNode(node) {
  return (
    `Current node:\n` +
    `  id: ${node.node_id}\n` +
    `  title: ${node.title}\n` +
    `  level: ${node.level}\n` +
    `  summary: ${(node.summary || node.routing_summary || "").slice(0, 280)}`
  );
}

function formatChildren(children) {
  if (!children || !children.length) return "Candidate children: (none)";
  const lines = children.map(
    (c, i) =>
      `${i + 1}. id=${c.node_id} | leaf=${!!c.is_leaf} | level=${c.level} | title="${c.title}"\n   summary: ${(c.routing_summary || c.summary || "").slice(0, 220)}`
  );
  return `Candidate children:\n${lines.join("\n")}`;
}

export function promptNavigate(query, currentNode, childOptions) {
  return [
    { role: "system", content: NAVIGATE_SYSTEM },
    {
      role: "user",
      content:
        `Question: ${query}\n\n` +
        `${formatCurrentNode(currentNode)}\n\n` +
        `${formatChildren(childOptions)}\n\n` +
        `Respond with ONE JSON object matching the schema. Use ids ONLY from the candidate list.`,
    },
  ];
}

export function promptKeywords(text) {
  return [
    { role: "system", content: "You extract concise keyword phrases from text. Output JSON only." },
    {
      role: "user",
      content:
        `Extract 3 to 8 keyword phrases that capture the distinctive content. ` +
        `Each phrase is 1 to 4 words. Return a JSON array of strings and nothing else.\n\n` +
        `Text:\n${text.slice(0, 4000)}\n\n` +
        `Output format: ["phrase one", "phrase two", "phrase three"]`,
    },
  ];
}
