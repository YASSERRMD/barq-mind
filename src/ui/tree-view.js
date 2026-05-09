// Renders the corpus tree as a collapsible nested list. Highlights the
// active navigation path when the navigator emits trace events.

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export function renderTreeView(target, tree, opts = {}) {
  const highlight = new Set(opts.highlightIds || []);
  if (!tree || !tree.getRoot()) {
    target.innerHTML = '<div class="muted">corpus is empty</div>';
    return;
  }
  const root = tree.getRoot();
  target.innerHTML = "";
  target.appendChild(renderNode(tree, root, highlight, 0));
}

function renderNode(tree, node, highlight, depth) {
  const wrap = document.createElement("div");
  wrap.className = `tnode level-${node.level}` + (highlight.has(node.node_id) ? " highlighted" : "");

  const header = document.createElement("div");
  header.className = "tnode-header";
  const children = tree.getChildren(node.node_id);

  if (children.length > 0) {
    const toggle = document.createElement("span");
    toggle.className = "toggle";
    toggle.textContent = depth < 2 ? "▾" : "▸";
    header.appendChild(toggle);
  } else {
    const dot = document.createElement("span");
    dot.className = "tnode-dot";
    dot.textContent = "•";
    header.appendChild(dot);
  }

  const title = document.createElement("span");
  title.className = "tnode-title";
  title.textContent = node.title || node.node_id;
  title.title = `${node.node_id}\n${(node.routing_summary || "").slice(0, 240)}`;
  header.appendChild(title);

  if (node.is_leaf && node.page_start != null) {
    const page = document.createElement("span");
    page.className = "tnode-page";
    page.textContent = `p${node.page_start}`;
    header.appendChild(page);
  }

  wrap.appendChild(header);

  if (children.length > 0) {
    const childWrap = document.createElement("div");
    childWrap.className = "tnode-children";
    if (depth >= 2) childWrap.style.display = "none";
    for (const child of children) {
      childWrap.appendChild(renderNode(tree, child, highlight, depth + 1));
    }
    wrap.appendChild(childWrap);

    header.addEventListener("click", () => {
      const showing = childWrap.style.display !== "none";
      childWrap.style.display = showing ? "none" : "block";
      const t = header.querySelector(".toggle");
      if (t) t.textContent = showing ? "▸" : "▾";
    });
  }

  return wrap;
}
