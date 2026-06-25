export type PdfExportResult = "saved" | "opened" | "downloaded";

export function safePdfFilename(name: string | undefined): string {
  const base = (name ?? "Worklin Deep Retention Audit")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "Worklin-Deep-Retention-Audit"}.pdf`;
}

export function openPdfPreparingWindow(title = "Preparing PDF"): Window | null {
  const opened = window.open("", "_blank");
  if (!opened) return null;
  opened.document.title = title;
  opened.document.body.style.margin = "0";
  opened.document.body.style.background = "#0b0b0b";
  opened.document.body.style.color = "#fff";
  opened.document.body.style.font = "16px system-ui, -apple-system, sans-serif";
  opened.document.body.innerHTML = `
    <main style="min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center">
      <div>
        <h1 style="font-size:20px;margin:0 0 8px">Preparing PDF</h1>
        <p style="color:#b8b8b8;margin:0">Worklin is rendering the audit export.</p>
      </div>
    </main>
  `;
  return opened;
}

export async function presentPdfBlob(
  blob: Blob,
  filename: string,
  previewWindow?: Window | null,
): Promise<PdfExportResult> {
  const pdfBlob =
    blob.type === "application/pdf"
      ? blob
      : new Blob([blob], { type: "application/pdf" });

  const url = URL.createObjectURL(pdfBlob);
  window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);

  if (previewWindow && !previewWindow.closed) {
    previewWindow.location.href = url;
    return "opened";
  }

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noreferrer";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();

  if (!document.hasFocus()) return "downloaded";

  const opened = window.open(url, "_blank");
  if (opened) return "opened";

  // Last-resort embedded-browser fallback: if popups and downloads are both
  // blocked, navigate the current tab to the generated PDF so the export is
  // still visible and can be saved from the browser PDF viewer.
  window.location.assign(url);
  return "opened";
}
