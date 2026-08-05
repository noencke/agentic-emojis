# Agentic Emojis

A 10×10 emoji picture lives in [`image.txt`](image.txt). Type a request in the web
UI and a [GitHub Agentic Workflow](https://github.github.com/gh-aw/) redraws it and
commits the result back to `main`.

It is a demo of **triggering an agentic workflow remotely** — from an app outside
GitHub — and passing it parameters.

## Running it

```sh
npm install
npm run dev
```

Then open the printed URL.

The dev server needs a GitHub token with `Actions: write` on this repo. It uses
`GITHUB_TOKEN` from the environment if set, and otherwise shells out to
`gh auth token --user noencke`, so normally there is nothing to configure and no
token ever lands on disk.

## How it works

```
browser  ──POST /api/dispatch──▶  Vite dev server  ──REST──▶  GitHub Actions
   ▲                              (holds the token)               │
   │                                                              ▼
   └──────GET /api/image────────  Contents API  ◀──commit──  agentic workflow
```

**The trigger.** `.github/workflows/edit-image.md` declares a `workflow_dispatch`
trigger with a single typed `prompt` input. The browser never sees a token: the
Vite dev server proxies three routes, holding the credential server-side.

| Route | Purpose |
| --- | --- |
| `GET /api/image` | Reads `image.txt` from `main` via the Contents API (always fresh, unlike the raw CDN) |
| `GET /api/status` | Lists recent runs so the UI can show progress, link to runs, and hold the submit button |
| `POST /api/dispatch` | Fires the workflow with the user's prompt |

**Reaching the agent.** gh-aw compiles `${{ github.event.inputs.prompt }}` in the
markdown body into an env binding that is substituted into the agent's prompt at
runtime. The value arrives as literal prompt text.

**Writing back.** gh-aw has no "commit to the default branch" safe output, and the
agent deliberately runs with `contents: read`. Instead the workflow declares a
custom safe-output job (`update-image`) with `contents: write`. The agent calls it
as a tool with the new grid; the job then writes and pushes `image.txt`. The agent
never holds write permission.

**One run at a time.** gh-aw emits a workflow-level concurrency group without
`cancel-in-progress`, so concurrent dispatches queue instead of clobbering each
other. The UI also disables submit while a run is active.

## Note on untrusted input

`workflow_dispatch` inputs are **not** sanitized by gh-aw — unlike issue- and
PR-triggered workflows, which get mention-neutralization and tag-stripping. The
prompt reaches the agent verbatim, so the workflow body wraps it in a `<request>`
element and instructs the agent to treat it strictly as a drawing instruction.
The residual risk is prompt injection, not shell injection: values are passed
through environment variables, never interpolated into a shell command.

## Editing the workflow

Edit the markdown, then recompile the lock file:

```sh
gh aw compile
```

Both `edit-image.md` and the generated `edit-image.lock.yml` are committed.
