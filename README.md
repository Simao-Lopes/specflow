# SpecFlow

**Spec-driven development orchestration.** Define features as specs, let an agent implement them against your git repo via pluggable harnesses and LLM providers, and collaborate with your team through configurable channels.

```
┌────────────┐   ┌─────────────────────────┐   ┌──────────────────┐
│  Channels   │──▶│        Core             │──▶│  Harnesses        │
│  Web UI     │   │  Specs / Jobs / Agents  │   │  Hermes           │
│  REST API   │   │  event bus / queue      │   │  Claude Code      │
│  CLI        │   │                         │   │  Custom shell     │
│  WhatsApp*  │   └──────────┬──────────────┘   │  Direct LLM       │
└────────────┘              │                    └────────┬─────────┘
                            │                          ┌────▼─────┐
                            │ Git layer               │  LLMs    │
                            └──► branch + PR ─────────► openrouter/nvidia/gemini
```

## Features

- **Spec-driven workflow** — features go through `backlog → in_progress → review → done`.
- **Editable steps pipeline** — each spec is implemented as a chain of steps (default `Plan → Code`). Reorder, add, edit, or delete steps in the UI.
- **Method-driven steps** — every step (and verify sub-agent) picks a method: an **industry template** (per phase `plan`/`code`/`test`, ordered simplest → most complex — Sketch→Specify→ADR→full design; Direct→TDD→Spec-first→Conventional→Parallel; Smoke→Unit→Contract→Integration→E2E; plus `review` and `docs`) **or a custom action** — a script you drop in `<repoRoot>/.specflow/actions/<phase>/`. Steps can also be fully custom.
- **All template methods ship the REAL methodology source** — every built-in template vendors and inlines its authentic, canonical prompt (not an approximation): GitHub **Spec Kit** (`/specify,/plan,/tasks,/implement,/checklist`), **MADR ADR**, **TDD** (Red-Green-Refactor + Three Laws), **Conventional Commits v1.0.0**, **Keep a Changelog**, Martin Fowler's **Test Pyramid**, and **OWASP Threat Modeling (STRIDE)**. Sources live under `templates/<methodology>/`; edit them and every pipeline using that method picks it up. See `src/methods/catalog.js`.
- **Prompts are materialized & stored** — the effective prompt for every step is written into the step on save + startup, so it is **always visible in the UI and editable/versioned** — not an invisible run-time side effect.
- **Disk store for pipelines** — each pipeline persists as a git-versionable folder: `<repoRoot>/.specflow/pipelines/<id>-<slug>/pipeline.json` (pure struct, no prompts) + `prompts/<step>.md` (one editable prompt file per step). Edit the `.md` files directly; they're re-read on restart. See `src/core/pipelinestore.js`.
- **Sub-agent verify flow (iterate)** — a step can define *verify sub-agents* (each also method-driven). If a verifier fails, the step re-runs with the failure fed back, up to its iteration budget — "code, then test, if test fails iterate".
- **Human gates** — the pipeline pauses after each step awaiting your Approve / Reject / Retry.
- **Interact with the agent** — every spec has an Agent Session chat. Messages persist and are injected into agent prompts as live guidance.
- **Pluggable agent harnesses** — per-step: `hermes`, `claude`, `custom` (own script/command), or `llm`.
- **Pluggable LLM providers** — OpenRouter, NVIDIA NIM, Google Gemini, Ollama, LiteLLM.
- **Git integration** — auto branch-per-spec, commit, and **open a PR (never auto-merges)**.
- **Configurable communication** — choose where the flow reports: web UI, REST, CLI, or optional WhatsApp webhook.
- **Web UI** — feature board, spec detail with steps builder + chat, agents, config, live job logs (Socket.IO).

## Quickstart

```bash
npm install
cp .env.example .env      # add API keys + repo config
npm run setup             # creates data/ and work/
npm start                 # -> http://localhost:9120/ui/
```

### Configure an agent

```bash
# Register an agent that ships specs to a repo via Claude Code
node src/cli.js agent create \
  --name "backend-bot" \
  --harness custom \
  --model claude-sonnet-4 \
  --provider openrouter \
  --repo git@github.com:owner/repo.git
```

### Create & run a spec

```bash
node src/cli.js spec create --title "Add health endpoint" --repo git@...:.git
node src/cli.js spec run <SPEC_ID>           # or via the UI: open the spec → Run
node src/cli.js job logs <JOB_ID>
```

The agent checks out `main`, creates `feature/spec-<id>`, implements the spec, commits, and opens a PR. **Review and merge the PR yourself** — SpecFlow never merges.

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

## Harnesses

- **`hermes`** — drives Hermes Agent headless (`hermes chat -q "<prompt>"`). Set `HERMES_BIN` to the hermes CLI path and ensure it's on the service PATH.
- **`claude`** — Claude Code CLI (`claude -p ... --dangerously-skip-permissions`).
- **`custom`** — arbitrary shell command; set `custom_command` in `config.example.yaml`. The template placeholders `{checkout}`, `{branch}`, `{prompt_file}` are replaced.
- **`llm`** — direct completion (no code agent): useful for planning/review.

## License

MIT