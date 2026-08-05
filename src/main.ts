import "./style.css";

const gridEl = document.querySelector<HTMLDivElement>("#grid")!;
const formEl = document.querySelector<HTMLFormElement>("#form")!;
const promptEl = document.querySelector<HTMLInputElement>("#prompt")!;
const submitEl = document.querySelector<HTMLButtonElement>("#submit")!;
const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const linksEl = document.querySelector<HTMLParagraphElement>("#links")!;

const POLL_MS = 3_000;
/** A dispatched run takes a moment to show up in the API; stay locked until it does. */
const DISPATCH_GRACE_MS = 30_000;

interface RunInfo {
  id: number;
  number: number;
  status: string;
  conclusion: string | null;
  url: string;
}

interface Status {
  busy: boolean;
  active: RunInfo | null;
  lastSuccess: RunInfo | null;
  latest: RunInfo | null;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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

function runLink(run: RunInfo, text: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = run.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = text;
  return link;
}

function applyBusy(next: boolean): void {
  busy = next;
  submitEl.disabled = next;
  promptEl.disabled = next;
  gridEl.classList.toggle("working", next);
}

/** The label carries the state class so `.working` can animate its trailing dots. */
function setStatus(
  kind: "" | "working" | "error",
  text: string,
  link?: { run: RunInfo; text: string },
): void {
  const label = document.createElement("span");
  if (kind) label.className = kind;
  label.textContent = text;
  statusEl.replaceChildren(label);
  if (link) statusEl.append(" — ", runLink(link.run, link.text));
}

/** Which run drew the picture currently on the default branch. */
function setProvenance(run: RunInfo | null): void {
  if (!run) return linksEl.replaceChildren();
  linksEl.replaceChildren("Current picture drawn by ", runLink(run, `run #${run.number}`));
}

async function poll(): Promise<void> {
  let status: Status;
  try {
    status = await api("/api/status");
  } catch (err) {
    setStatus("error", message(err));
    return;
  }

  if (status.busy) dispatchedAt = null;
  const withinGrace =
    dispatchedAt !== null && Date.now() - dispatchedAt < DISPATCH_GRACE_MS;
  const busyNow = status.busy || withinGrace;
  const finished = busy && !busyNow;

  applyBusy(busyNow);
  const { active, latest } = status;
  if (busyNow) {
    setStatus(
      "working",
      "Drawing",
      active ? { run: active, text: `watch run #${active.number}` } : undefined,
    );
  } else if (latest?.conclusion && latest.conclusion !== "success") {
    setStatus("error", `Last run ${latest.conclusion}.`, {
      run: latest,
      text: `see run #${latest.number}`,
    });
  } else {
    setStatus("", "");
  }
  setProvenance(status.lastSuccess);

  if (finished) {
    dispatchedAt = null;
    await loadImage();
  }
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = promptEl.value.trim();
  if (busy || !prompt) return;

  applyBusy(true);
  setStatus("working", "Dispatching");
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
    applyBusy(false);
    setStatus("error", message(err));
  }
});

await loadImage().catch((err: unknown) => setStatus("error", message(err)));
await poll();
setInterval(() => void poll(), POLL_MS);
