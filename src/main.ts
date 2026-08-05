import "./style.css";

const gridEl = document.querySelector<HTMLDivElement>("#grid")!;
const formEl = document.querySelector<HTMLFormElement>("#form")!;
const promptEl = document.querySelector<HTMLInputElement>("#prompt")!;
const submitEl = document.querySelector<HTMLButtonElement>("#submit")!;
const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;

const POLL_MS = 3_000;
/** A dispatched run takes a moment to show up in the API; stay locked until it does. */
const DISPATCH_GRACE_MS = 30_000;

interface RunInfo {
  id: number;
  status: string;
  conclusion: string | null;
  url: string;
}

let busy = false;
let dispatchedAt: number | null = null;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

/**
 * Split on grapheme clusters rather than code points so multi-codepoint emoji
 * (skin tones, ZWJ sequences) still occupy a single cell.
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const cellsOf = (line: string): string[] =>
  [...segmenter.segment(line)].map((s) => s.segment);

function renderGrid(raw: string): void {
  const rows = raw
    .split(/\r?\n/)
    .map((line) => cellsOf(line.trim()))
    .filter((cells) => cells.length > 0);

  gridEl.style.setProperty("--cols", String(Math.max(...rows.map((r) => r.length), 1)));
  gridEl.replaceChildren(
    ...rows.flat().map((char) => {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.textContent = char;
      return cell;
    }),
  );
}

async function loadImage(): Promise<void> {
  const { grid } = await api<{ grid: string }>("/api/image");
  renderGrid(grid);
}

function setBusy(next: boolean, run: RunInfo | null): void {
  busy = next;
  submitEl.disabled = next;
  promptEl.disabled = next;
  gridEl.classList.toggle("working", next);

  if (next) {
    statusEl.className = "status working";
    statusEl.textContent = run ? `Drawing… (run ${run.id})` : "Drawing…";
    return;
  }
  statusEl.className = "status";
  statusEl.textContent =
    run && run.conclusion && run.conclusion !== "success"
      ? `Last run ${run.conclusion}. See the run log for details.`
      : "";
}

async function poll(): Promise<void> {
  let status: { busy: boolean; run: RunInfo | null };
  try {
    status = await api("/api/status");
  } catch (err) {
    statusEl.className = "status error";
    statusEl.textContent = err instanceof Error ? err.message : String(err);
    return;
  }

  if (status.busy) dispatchedAt = null;
  const withinGrace =
    dispatchedAt !== null && Date.now() - dispatchedAt < DISPATCH_GRACE_MS;
  const busyNow = status.busy || withinGrace;

  const finished = busy && !busyNow;
  setBusy(busyNow, status.run);
  if (finished) {
    dispatchedAt = null;
    await loadImage();
  }
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = promptEl.value.trim();
  if (busy || !prompt) return;

  setBusy(true, null);
  statusEl.textContent = "Dispatching…";
  try {
    await api("/api/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    promptEl.value = "";
    dispatchedAt = Date.now();
    setTimeout(() => void poll(), 1_500);
  } catch (err) {
    setBusy(false, null);
    statusEl.className = "status error";
    statusEl.textContent = err instanceof Error ? err.message : String(err);
  }
});

await loadImage().catch((err: unknown) => {
  statusEl.className = "status error";
  statusEl.textContent = err instanceof Error ? err.message : String(err);
});
await poll();
setInterval(() => void poll(), POLL_MS);
