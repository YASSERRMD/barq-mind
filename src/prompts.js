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
  if (!children || !children.length) return "Candidates: (none)";
  // Use a JSON-array format so the model echoes the `id` field verbatim
  // instead of treating the surrounding text as part of the id.
  // Cap each summary when the candidate list is large to control prompt size.
  const charBudget = children.length > 8 ? 80 : 220;
  const items = children.map((c) => {
    const obj = {
      id: c.node_id,
      title: c.title,
      level: c.level,
      is_leaf: !!c.is_leaf,
      summary: (c.routing_summary || c.summary || "").slice(0, charBudget),
    };
    return "  " + JSON.stringify(obj);
  });
  return `Candidates (JSON array; copy "id" values exactly):\n[\n${items.join(",\n")}\n]`;
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

export const SYNTHESIZE_SYSTEM =
  "You are a precise question-answering assistant. Use ONLY the provided excerpts. " +
  "Answer in 2 to 4 sentences. End with a Sources line listing the section names and " +
  "page numbers (or node_ids if no pages). If the excerpts do not contain the answer, " +
  "say 'Insufficient evidence in the indexed sources.'";

function citationLabel(leaf) {
  if (leaf.page_start != null) {
    const pageRange =
      leaf.page_end && leaf.page_end !== leaf.page_start
        ? `${leaf.page_start}-${leaf.page_end}`
        : `${leaf.page_start}`;
    return `${leaf.title} p${pageRange}`;
  }
  return `${leaf.title} [${leaf.node_id}]`;
}

function formatLeaves(leaves) {
  // Use the citation label itself as the excerpt header so the model is
  // primed to copy it verbatim into the Sources line. Avoid bare numeric
  // indexes like "[1]" that the model otherwise echoes back as "Excerpt 1".
  return leaves
    .map((leaf) => {
      const text = (leaf.text || "").slice(0, 1500);
      return `--- ${citationLabel(leaf)} ---\n${text}`;
    })
    .join("\n\n");
}

export function promptSynthesize(query, leaves, navPath) {
  const pathLine =
    navPath && navPath.length
      ? `Navigation path: ${navPath.map((p) => p.title || p).join(" > ")}`
      : "Navigation path: (root)";
  const citationExamples = leaves
    .slice(0, 2)
    .map(citationLabel)
    .join(", ");
  return [
    { role: "system", content: SYNTHESIZE_SYSTEM },
    {
      role: "user",
      content:
        `Question: ${query}\n\n${pathLine}\n\nExcerpts:\n${formatLeaves(leaves)}\n\n` +
        `Answer in 2 to 4 sentences using ONLY the excerpts. ` +
        `End with a single line beginning with "Sources:" that lists the section labels exactly as shown above the excerpts ` +
        `(for example: Sources: ${citationExamples || "<section title> p<page>"}). ` +
        `Do NOT use generic labels like "Excerpt 1".`,
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
