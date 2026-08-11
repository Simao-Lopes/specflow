# SpecFlow

**Spec-driven development orchestration.** Define features as specs, run them through method-driven pipelines (industry templates or custom actions), let an agent implement against your git repo via pluggable harnesses and LLM providers, and connect your tools via MCP.

```
┌──────────┐   ┌────────────────────────┐   ┌──────────────┐
│ Channels │──▶│        Core            │──▶│  Harnesses   │
│ Web UI   │   │ Specs / Jobs/Agents    │   │  Hermes      │
│ REST API │   │ Pipelines / Methods    │   │  Claude Code │
│ CLI      │   │ event bus / queue      │   │  Custom shell│
│ (WhatsApp)│  └────────┬───────────────┘   │  Direct LLM  │
└──────────┘            │                    └──────┬───────┘
                        │                      ┌─────▼─────┐
                        ├── Git layer ─────────▶│  LLMs     │
                        │  branch + PR (no merge)│ + MCP     │
                        │                      └───────────┘
                        └── MCP tools (git / Jira / Slack / …)
```

## Features

- **Spec-driven workflow** — features go through `backlog → in_progress → review → done`.
- **Pipelines are first-class** — a spec selects a reusable pipeline (its step chain). Dedicated **Pipelines** screen to build/edit them; a spec editor just picks one.
- **Method-driven steps** — every pipeline step (and verify sub-agent) picks a **method**: an **industry template** (ordered simplest → most complex across `plan`/`code`/`test`/`review`/`docs`) **or a custom action** — a script you drop in `<repoRoot>/.specflow/actions/<phase>/`. Steps can also be fully custom.
- **All template methods ship the REAL methodology source** — every built-in template inlines its authentic, canonical prompt (not an approximation): GitHub **Spec Kit** (`/specify /plan /tasks /implement /checklist`), **MADR ADR**, **TDD** (Red-Green-Refactor + Three Laws), **Conventional Commits v1.0.0**, **Keep a Changelog**, Martin Fowler's **Test Pyramid**, **OWASP Threat Modeling (STRIDE)**. Sources live under [`templates/<methodology>/`](templates/); edit them and every pipeline using that method picks it up. See [`src/methods/catalog.js`](src/methods/catalog.js).
- **Prompts are materialized & stored** — the effective prompt for every step is written onto the step on save + startup, so it is **always visible in the UI and editable/versioned** — never an invisible run-time side effect.
- **Disk store for pipelines** — each pipeline persists as a git-versionable folder: `<repoRoot>/.specflow/pipelines/<id>-<slug>/pipeline.json` (pure struct, no prompts) + `prompts/<step>.md` (one editable prompt file per step). Edit the `.md` files directly; they're re-read on restart. See `src/core/pipelinestore.js`.
- **Sub-agent verify flow (iterate)** — a step can define *verify sub-agents* (each method-driven). If a verifier fails the step re-runs with failure fed back, up to its iteration budget — "code, then test, if test fails iterate".
- **Human gates** — the pipeline pauses after each step awaiting your Approve / Reject / Retry.
- **Interact with the agent** — every spec has an Agent Session chat; messages persist and are injected into agent prompts as live guidance.
- **Pluggable agent harnesses** — per-step: `hermes`, `claude`, `custom` (own script/command), or `llm`.
- **Pluggable LLM providers** — OpenRouter, NVIDIA NIM, Google Gemini, Ollama, LiteLLM.
- **Git integration** — auto branch-per-spec, commit, and **open a PR (never auto-merges)**. Named repo **connections** are manageable in Config.
- **MCP tool connections** — connect MCP servers (git, Jira, Slack, filesystem, etc.) in Config. Every pipeline node can access every configured MCP.
- **Configurable communication** — choose where the flow reports: web UI, REST, CLI, or optional WhatsApp webhook.
- **Web UI** — feature board, spec detail (steps + chat + runs), pipelines builder, agents, config, live job logs (Socket.IO). **Mobile-friendly** step editor.

## Quickstart

```bash
npm install
cp .env.example .env      # add API keys + repo config
npm run setup             # creates data/ and work/
npm start                 # -> http://localhost:9120/ui/
```

On first start SpecFlow seeds 6 industry pipelines (GitHub Spec Kit Full Flow, TDD, Security-First OWASP, Performance-Aware, Docs + Release, MVP Quick Start) plus a default, and materializes prompts for every step.

### Create & run a spec (UI)

1. **New Spec** — title, description, acceptance criteria, repo (or pick a connection), pipeline.
2. **Run** — uses the pipeline's methods (no model/harness re-ask).
3. The pipeline executes step-by-step; after each step it **pauses** for your **Approve / Reject / Retry**.
4. Steps that commit open a **PR** for you to review and merge.

### CLI

```bash
node src/cli.js spec create --title "Add health endpoint" --repo git@github.com:owner/repo.git
node src/cli.js spec run <SPEC_ID>
node src/cli.js job logs <JOB_ID>
```

## Connecting your tools (MCP)

MCP (Model Context Protocol) lets pipeline agents use real tools. Add a server in **Config → MCP Connections**; every configured MCP is exposed to every pipeline node.

```bash
# Example stdio MCP server (local command):
#   name: git            | command: /usr/local/bin/mcp-git-server
# Example remote (SSE):
#   name: jira           | url: https://mcp.jira.example.com/sse
```

- Supported transports: **stdio** (local command) and **SSE / streamable HTTP** (remote URL).
- Each entry saves a name, transport, command/URL, optional args – and is **tested** (handshake + tool list).
- Tools are injected into step prompts as "available MCP tools" so any node (plan, code, test, review) can call them.

## Configuration

See `config.example.yaml` and `.env.example`. Key options:

| Config | Meaning |
|--------|---------|
| `SPECFLOW_PORT` | HTTP port (default 9120) |
| `SPECFLOW_DB` | SQLite path (default `data/specflow.db`) |
| `SPECFLOW_REPO_ROOT` | where repos are cloned (default `./work`) |
| `OPENROUTER_API_KEY` | for `provider: openrouter` |
| `NVIDIA_API_KEY` | for `provider: nvidia` |
| `GOOGLE_API_KEY` | for `provider: gemini` |
| `GITHUB_TOKEN` | token for auto-creating PRs |
| `SPECFLOW_WHATSAPP_WEBHOOK_URL` | optional outbound WhatsApp/webhook relay |

### Editable preferences (Config → Preferences)

Default harness, provider, model, repo, base branch, LLM provider/model — used as fallbacks when a spec/step doesn't specify.

## Harnesses

- **`hermes`** — drives Hermes Agent headless (`hermes chat -q "<prompt>"`). Set `HERMES_BIN`.
- **`claude`** — Claude Code CLI (`claude -p ... --dangerously-skip-permissions`).
- **`custom`** — arbitrary shell command; template placeholders `{checkout}`, `{branch}`, `{prompt_file}` are replaced.
- **`llm`** — direct completion (no code agent): useful for planning/review.

## License

MIT © Simão Lopes