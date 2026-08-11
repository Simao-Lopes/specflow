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
- **Pluggable agent harnesses** — `hermes`, `claude`, `custom` (own script/command), or direct `llm`.
- **Pluggable LLM providers** — OpenRouter, NVIDIA NIM, Google Gemini, or any OpenAI-compatible API.
- **Git integration** — auto branch-per-spec, commit, and **open a PR (never auto-merges)**.
- **Configurable communication** — choose where the flow reports: web UI, REST, CLI, and optional WhatsApp webhook.
- **Web UI** — feature board, spec editor, agent config, live job logs (Socket.IO).

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