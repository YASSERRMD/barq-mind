// pdf.js loader for page-aware text extraction. Returns a pages array shaped
// like [{page_number, text}, ...] that ingestPaged consumes.

const PDFJS_VERSION = "4.0.379";
const PDFJS_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`;
const PDFJS_WORKER_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;

let pdfjsLib = null;

async function ensurePdfJs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import(PDFJS_URL);
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  return pdfjsLib;
}

export async function extractPdfPages(arrayBuffer, opts = {}) {
  const lib = await ensurePdfJs();
  const loadingTask = lib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => (item.hasEOL ? item.str + "\n" : item.str))
      .join(" ");
    pages.push({ page_number: i, text });
    if (typeof opts.onProgress === "function") opts.onProgress(i, pdf.numPages);
  }
  return pages;
}
