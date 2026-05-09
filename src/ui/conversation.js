// Renders the conversation: user prompts, system notes, answers, and trace blocks.

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function appendUser(target, text) {
  const row = el("div", "msg user");
  row.append(el("div", "msg-role", "you"), el("div", "msg-body", text));
  target.appendChild(row);
  scrollToBottom(target);
}

export function appendSystem(target, text, kind = "info") {
  const row = el("div", `msg system ${kind}`);
  row.append(el("div", "msg-role", "system"), el("div", "msg-body", text));
  target.appendChild(row);
  scrollToBottom(target);
}

export function appendAnswer(target, result) {
  const row = el("div", "msg assistant");
  row.append(el("div", "msg-role", "barq"));
  const body = el("div", "msg-body");
  body.appendChild(el("div", "answer-text", result.answer));
  if (result.citations && result.citations.length > 0) {
    const cites = el("div", "citations");
    cites.append(el("span", "cite-label", "Sources: "));
    for (const c of result.citations) {
      const tag = el("span", "cite");
      let label = c.section || c.node_id || "?";
      if (c.page != null) label += ` p${c.page}`;
      tag.textContent = label;
      cites.appendChild(tag);
    }
    body.appendChild(cites);
  }
  if (result.fallback) {
    body.appendChild(el("div", "fallback-note", "(BM25 fallback used)"));
  }
  const footer = el("div", "msg-footer");
  const ms = result.durationMs ? `${Math.round(result.durationMs)}ms` : "";
  footer.textContent = ms;
  body.appendChild(footer);
  row.appendChild(body);
  target.appendChild(row);
  scrollToBottom(target);
}

export function appendTrace(target, trace) {
  const row = el("div", "msg trace");
  row.append(el("div", "msg-role", "trace"));
  const body = el("div", "msg-body");
  for (const ev of trace) {
    const item = el("div", "trace-item");
    const head = el("div", "trace-head");
    head.textContent = `[depth ${ev.depth}] ${ev.action.action} (${Math.round(ev.duration_ms)}ms)`;
    const reason = el("div", "trace-reason", ev.action.reason || "");
    item.append(head, reason);
    if (ev.candidates && ev.candidates.length) {
      const candList = el("div", "trace-candidates");
      candList.textContent = `candidates: ${ev.candidates.map((c) => c.title).join(", ")}`;
      item.appendChild(candList);
    }
    body.appendChild(item);
  }
  row.appendChild(body);
  target.appendChild(row);
  scrollToBottom(target);
}

function scrollToBottom(target) {
  target.scrollTop = target.scrollHeight;
}

export function clearConversation(target) {
  target.innerHTML = "";
}
