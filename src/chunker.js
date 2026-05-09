// Structural and sentence-aware chunkers. Deterministic, no LLM. The chunkers
// produce a tree of {level, title, text, char_start, char_end, children, page_*}
// records that ingest.js translates into NodeRecord trees.

const TARGET_TOKENS = 400;
const MAX_TOKENS = 800;
const TARGET_CHARS = TARGET_TOKENS * 4;
const MAX_CHARS = MAX_TOKENS * 4;

const ABBREVIATIONS = new Set([
  "Mr.", "Mrs.", "Ms.", "Dr.", "Sr.", "Jr.",
  "etc.", "e.g.", "i.e.", "vs.", "St.", "Ave.",
  "Inc.", "Ltd.", "Co.", "Corp.",
  "U.S.", "U.K.", "E.U.",
]);

export function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

function trimRange(text, start, end) {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return [s, e];
}

export function chunkMarkdown(text, opts = {}) {
  const targetChars = opts.targetChars || TARGET_CHARS;
  const maxChars = opts.maxChars || MAX_CHARS;

  const lines = text.split(/\n/);
  // Compute char offsets for each line.
  const offsets = new Array(lines.length);
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = cursor;
    cursor += lines[i].length + 1;
  }

  // Identify heading lines.
  const headings = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (m) {
      headings.push({
        level: m[1].length,
        title: m[2],
        line: i,
        char_start: offsets[i],
        char_end: offsets[i] + lines[i].length,
      });
    }
  }

  // If no headings: treat the whole document as one section with paragraph leaves.
  if (headings.length === 0) {
    const root = {
      level: 1,
      title: opts.defaultTitle || "Document",
      char_start: 0,
      char_end: text.length,
      text: "",
      children: [],
    };
    splitToLeaves(text, 0, text.length, root, targetChars, maxChars);
    return root;
  }

  // Build heading hierarchy as a tree.
  const root = {
    level: 0,
    title: opts.defaultTitle || "Document",
    char_start: 0,
    char_end: text.length,
    text: "",
    children: [],
  };

  const stack = [root];
  for (let h = 0; h < headings.length; h++) {
    const head = headings[h];
    const next = headings[h + 1];
    const bodyStart = head.char_end + 1;
    const bodyEnd = next ? next.char_start : text.length;
    const [bs, be] = trimRange(text, bodyStart, bodyEnd);

    while (stack.length > 1 && stack[stack.length - 1].level >= head.level) {
      stack.pop();
    }

    const node = {
      level: head.level,
      title: head.title,
      char_start: head.char_start,
      char_end: bodyEnd,
      text: "",
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    stack.push(node);

    // Body text between this heading and the next: split into paragraph leaves.
    if (bs < be) {
      splitToLeaves(text, bs, be, node, targetChars, maxChars);
    }
  }

  return root;
}

function splitToLeaves(text, start, end, parent, targetChars, maxChars) {
  // Split body into paragraphs (blank-line separated), then size-bound each.
  const body = text.slice(start, end);
  const paraRegex = /\n\s*\n+/g;
  const splits = [];
  let lastIdx = 0;
  let m;
  while ((m = paraRegex.exec(body)) !== null) {
    splits.push([lastIdx, m.index]);
    lastIdx = m.index + m[0].length;
  }
  splits.push([lastIdx, body.length]);

  for (const [ps, pe] of splits) {
    const [ts, te] = trimRange(body, ps, pe);
    if (ts >= te) continue;
    const absStart = start + ts;
    const absEnd = start + te;
    const paragraph = text.slice(absStart, absEnd);
    if (paragraph.length <= maxChars) {
      parent.children.push(makeLeaf(paragraph, absStart, absEnd));
    } else {
      const subChunks = splitBySentences(paragraph, targetChars, maxChars);
      let offset = 0;
      for (const piece of subChunks) {
        const idx = paragraph.indexOf(piece, offset);
        const a = absStart + idx;
        const b = a + piece.length;
        parent.children.push(makeLeaf(piece, a, b));
        offset = idx + piece.length;
      }
    }
  }
}

function makeLeaf(textSlice, char_start, char_end, page_start = null, page_end = null) {
  return {
    level: "leaf",
    title: deriveTitle(textSlice),
    char_start,
    char_end,
    text: textSlice,
    children: [],
    page_start,
    page_end,
  };
}

function deriveTitle(textSlice) {
  const firstLine = textSlice.split(/\n/)[0].replace(/[#>*_`]/g, "").trim();
  if (firstLine.length > 80) return firstLine.slice(0, 77) + "...";
  return firstLine || "Untitled";
}

export function chunkPagedDocument(pages, opts = {}) {
  const targetChars = opts.targetChars || TARGET_CHARS;
  const maxChars = opts.maxChars || MAX_CHARS;
  const out = [];
  let runningChar = 0;
  for (const page of pages) {
    if (typeof page !== "object" || typeof page.page_number !== "number") {
      throw new Error("chunkPagedDocument: pages must have page_number");
    }
    const text = page.text || "";
    const pageStart = runningChar;
    if (text.length <= maxChars) {
      out.push({
        level: "page",
        title: `Page ${page.page_number}`,
        char_start: pageStart,
        char_end: pageStart + text.length,
        text,
        page_start: page.page_number,
        page_end: page.page_number,
        children: [],
      });
    } else {
      const pieces = splitBySentences(text, targetChars, maxChars);
      const children = [];
      let cursor = 0;
      for (const piece of pieces) {
        const idx = text.indexOf(piece, cursor);
        const start = pageStart + (idx >= 0 ? idx : cursor);
        const end = start + piece.length;
        children.push({
          level: "leaf",
          title: deriveTitle(piece),
          char_start: start,
          char_end: end,
          text: piece,
          page_start: page.page_number,
          page_end: page.page_number,
          children: [],
        });
        cursor = (idx >= 0 ? idx : cursor) + piece.length;
      }
      out.push({
        level: "page",
        title: `Page ${page.page_number}`,
        char_start: pageStart,
        char_end: pageStart + text.length,
        text: "",
        page_start: page.page_number,
        page_end: page.page_number,
        children,
      });
    }
    runningChar += text.length + 1;
  }
  return out;
}

export function chunkPlainText(text, opts = {}) {
  const targetChars = opts.targetChars || TARGET_CHARS;
  const maxChars = opts.maxChars || MAX_CHARS;
  const chunks = [];
  const pieces = splitBySentences(text, targetChars, maxChars);
  let cursor = 0;
  for (const piece of pieces) {
    const idx = text.indexOf(piece, cursor);
    const start = idx >= 0 ? idx : cursor;
    const end = start + piece.length;
    chunks.push(makeLeaf(piece, start, end));
    cursor = end;
  }
  return chunks;
}

export function splitBySentences(text, targetChars = TARGET_CHARS, maxChars = MAX_CHARS) {
  const sentences = sentenceSplit(text);
  const chunks = [];
  let buf = "";
  for (const s of sentences) {
    if (s.length > maxChars) {
      if (buf) {
        chunks.push(buf);
        buf = "";
      }
      const pieces = hardSplit(s, maxChars);
      for (const p of pieces) chunks.push(p);
      continue;
    }
    if (buf.length + s.length > targetChars && buf.length > 0) {
      chunks.push(buf);
      buf = s;
    } else {
      buf = buf ? buf + " " + s : s;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function sentenceSplit(text) {
  const out = [];
  const tokens = text.split(/\s+/);
  let buf = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    buf.push(t);
    if (/[.!?]$/.test(t) && !ABBREVIATIONS.has(t)) {
      const next = tokens[i + 1];
      if (!next || /^[A-Z(]/.test(next)) {
        out.push(buf.join(" "));
        buf = [];
      }
    }
  }
  if (buf.length) out.push(buf.join(" "));
  return out;
}

function hardSplit(text, maxChars) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxChars, text.length);
    if (end < text.length) {
      const back = text.lastIndexOf(" ", end);
      if (back > i + maxChars / 2) end = back;
    }
    out.push(text.slice(i, end).trim());
    i = end;
  }
  return out;
}
