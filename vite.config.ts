import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";

const OWNER = "noencke";
const REPO = "agentic-emojis";
const BRANCH = "main";
const WORKFLOW_FILE = "edit-image.lock.yml";
const IMAGE_PATH = "image.txt";

/**
 * The dispatch API needs a token with `Actions: write`, which must never reach the
 * browser. It stays here in the dev server. Preferring the gh CLI means no token
 * has to be written to disk at all.
 */
let cachedToken: string | undefined;
function githubToken(): string {
  if (cachedToken) return cachedToken;
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnv) return (cachedToken = fromEnv);
  try {
    cachedToken = execFileSync("gh", ["auth", "token", "--user", OWNER], {
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      `No GitHub token. Either set GITHUB_TOKEN, or run: gh auth login --user ${OWNER}`,
    );
  }
  if (!cachedToken) throw new Error("gh auth token returned nothing.");
  return cachedToken;
}

async function github(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${githubToken()}`,
      "x-github-api-version": "2022-11-28",
      ...init.headers,
    },
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const ACTIVE = new Set(["queued", "in_progress", "requested", "waiting", "pending"]);

/** Current grid, straight from the default branch. */
async function handleImage(res: ServerResponse): Promise<void> {
  const r = await github(
    `/repos/${OWNER}/${REPO}/contents/${IMAGE_PATH}?ref=${BRANCH}`,
    { headers: { accept: "application/vnd.github.raw" } },
  );
  if (!r.ok) return sendJson(res, r.status, { error: await r.text() });
  sendJson(res, 200, { grid: await r.text() });
}

const brief = (run: WorkflowRun | undefined) =>
  run
    ? {
        id: run.id,
        number: run.run_number,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url,
      }
    : null;

/**
 * One request covers everything the UI needs: whether a run is active (so it can
 * show progress and hold the submit button), and the last successful run, which is
 * the one that drew the picture currently on the default branch.
 */
async function handleStatus(res: ServerResponse): Promise<void> {
  const r = await github(
    `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=10`,
  );
  if (!r.ok) return sendJson(res, r.status, { error: await r.text() });
  const { workflow_runs: runs = [] } = (await r.json()) as { workflow_runs?: WorkflowRun[] };
  const active = runs.find((run) => ACTIVE.has(run.status));
  sendJson(res, 200, {
    busy: Boolean(active),
    active: brief(active),
    lastSuccess: brief(runs.find((run) => run.conclusion === "success")),
    latest: brief(runs[0]),
  });
}

/** Fire the agentic workflow. Returns the run id so the UI can start tracking it. */
async function handleDispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { prompt } = JSON.parse((await readBody(req)) || "{}") as { prompt?: string };
  if (!prompt?.trim()) return sendJson(res, 400, { error: "A prompt is required." });

  const r = await github(
    `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      body: JSON.stringify({ ref: BRANCH, inputs: { prompt: prompt.trim() } }),
    },
  );
  if (!r.ok) return sendJson(res, r.status, { error: await r.text() });
  // GitHub's REST docs describe a 200 carrying workflow_run_id/run_url/html_url,
  // but the endpoint actually answers 204 with an empty body. The UI therefore
  // discovers the run by polling /api/status rather than from this response.
  sendJson(res, 202, { ok: true });
}

interface WorkflowRun {
  id: number;
  run_number: number;
  status: string;
  conclusion: string | null;
  html_url: string;
}

function githubProxy(): Plugin {
  return {
    name: "github-proxy",
    configureServer(server) {
      server.middlewares.use("/api", (req, res, next) => {
        const route = (req.url ?? "/").split("?")[0];
        const handler =
          route === "/image" && req.method === "GET"
            ? handleImage(res)
            : route === "/status" && req.method === "GET"
              ? handleStatus(res)
              : route === "/dispatch" && req.method === "POST"
                ? handleDispatch(req, res)
                : null;
        if (!handler) return next();
        handler.catch((err: unknown) =>
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }),
        );
      });
    },
  };
}

export default defineConfig({ plugins: [githubProxy()] });
