// Renders the document list with delete buttons.

export function renderDocList(target, documents, onRemove) {
  if (!documents || documents.length === 0) {
    target.innerHTML = '<div class="muted">no documents</div>';
    return;
  }
  target.innerHTML = "";
  for (const doc of documents) {
    const row = document.createElement("div");
    row.className = "doc-row";
    const title = document.createElement("span");
    title.className = "doc-title";
    title.textContent = doc.title;
    title.title = doc.docId;
    const meta = document.createElement("span");
    meta.className = "doc-meta";
    meta.textContent = `${doc.leafCount} leaves`;
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "Remove document";
    del.className = "icon-btn";
    del.addEventListener("click", () => onRemove(doc.docId));
    row.append(title, meta, del);
    target.appendChild(row);
  }
}
