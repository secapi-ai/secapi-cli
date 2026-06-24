# SEC API CLI

Command-line interface for SEC API factor data, SEC filings, financial statements, ownership data, and agent workflows.

## Installation

```bash
npm install -g @secapi/cli
```

## Local development

Run the TypeScript entrypoint directly while iterating. Keep credentials in the
environment or stdin; never add real keys to command history, fixtures, or docs:

```bash
bun packages/cli/src/index.ts --help
bun packages/cli/src/index.ts agent-context --output secapi-cli-context.json
SECAPI_API_KEY="$SECAPI_API_KEY" bun packages/cli/src/index.ts me --json=false
printf "%s" "$SECAPI_API_KEY" | bun packages/cli/src/index.ts health --api-key-stdin
```

Use the focused package checks before committing CLI changes:

```bash
bun --filter @secapi/cli test
bun --filter @secapi/cli typecheck
bun run bench:cli-response-shape
bun run smoke:cli-release
bun run scripts/validate/check_cli_doc_snippets.ts
```

`bun run bench:cli-response-shape` exercises representative local-only help,
example, config, and agent discovery commands with no credentials and fails if
their latency or output size drifts past conservative agent-friendly budgets.

`bun run smoke:cli-release` builds, packs, installs the tarball in a clean
temporary project, and verifies the installed `secapi` and `omni-sec` binaries.
Run `bun run scripts/validate/check_cli_doc_snippets.ts` whenever CLI examples,
command names, or public Mintlify snippets change; it rewrites
`ops/docs-health/cli-doc-snippets/latest.json`.

## Connect an agent

Wire the hosted MCP server into your agent client in one command:

```bash
secapi init --client claude-code      # prints the `claude mcp add` command
secapi init --client cursor           # writes .cursor/mcp.json
secapi init --client claude-desktop   # writes the Claude Desktop config
secapi init --client windsurf         # writes ~/.codeium/windsurf/mcp_config.json
secapi init --client project          # writes ./.mcp.json
secapi init --client cursor --print   # dry-run: print the config, write nothing
secapi mcp install --client cursor    # alias for agent-client MCP setup
```

`secapi init` reads your key from `SECAPI_API_KEY` (or `--api-key-stdin`) and never
accepts it as an argv flag. `secapi agent-context` prints a machine-readable JSON
description of the whole CLI surface, including the full current command group
inventory, auth needs, mutating/read-only posture, output shape, required flags,
and examples, so an agent can learn the tool in one call.

## Configuration

```bash
export SECAPI_API_KEY="secapi_live_..."
export SECAPI_BASE_URL="https://api.secapi.ai"
```

`SECAPI_BASE_URL` is optional. The CLI defaults to `https://api.secapi.ai`.
Use `--base-url <url>` when a single command should target a local, staging,
proxy, or replay origin without changing your shell environment:

```bash
secapi health --base-url http://127.0.0.1:8787
```

Use a no-secret profile when you switch between local, staging, and production
often. Profiles live at `~/.config/secapi/profiles.json` by default and may set
`baseUrl`, `apiKeyEnv`, and `bearerTokenEnv`. The file stores environment
variable names, not credential values. Set `SECAPI_CONFIG_FILE` when CI or an
agent runner should read profiles from a different path:

```json
{
  "profiles": {
    "local": {
      "baseUrl": "http://127.0.0.1:8787",
      "apiKeyEnv": "SECAPI_LOCAL_API_KEY"
    }
  }
}
```

```bash
export SECAPI_LOCAL_API_KEY="secapi_live_..."
SECAPI_PROFILE=local secapi health
secapi --profile local config show
secapi config profiles
```

Two binaries are installed: the preferred `secapi` and the compatibility alias `omni-sec`.

```bash
secapi --version   # prints the bare package version, e.g. 1.0.2
secapi --help      # short task-oriented help for common workflows
secapi help all    # full command inventory
secapi examples    # local starter workflows for humans and agents
secapi config show # local config/auth-source summary; no API request
secapi config profiles # list no-secret profiles; no API request
secapi doctor      # checks base URL, auth source, health, account context, and MCP setup
secapi filings latest --help  # command-specific help; no API request
secapi completion zsh         # shell completions for secapi and omni-sec
```

Unknown commands fail locally with nearest-command suggestions, so a typo like
`secapi filings latset` points back to `secapi filings latest` without making an
API request.

Unknown option typos fail locally too, so `secapi filings search --limt 5`
points back to `--limit` before credentials are read or an API request is sent.

Preview high-impact mutating commands before they touch account state by adding
`--dry-run`. The CLI prints the method, endpoint, and JSON body locally without
reading credentials or making an API request:

```bash
secapi api-keys create --label local-dev --scopes read:sec --dry-run
secapi billing checkout --plan personal --dry-run
secapi webhooks create --destination-url https://example.com/hooks/sec --event-types artifact.created --dry-run
secapi streams create --event-types artifact.created --transport poll --dry-run
```

Supported dry-run previews: `api-keys create`, `billing budget`, `billing
checkout`, `billing portal`, `webhooks create`, `webhooks rotate-secret`,
`webhooks replay-delivery`, and `streams create`.

Boolean flags accept bare flags plus explicit `true`, `false`, `yes`, `no`,
`on`, `off`, `1`, and `0` values. Use `--include-v2=false` or `--print=false`
when generated commands need to force an opt-in flag off without changing the
command shape.

Write structured JSON or generated scripts directly to a file with
`--output <path>`, for example:

```bash
secapi agent-context --output secapi-cli-context.json
```

When you need diagnostics without breaking a stdout pipeline, add
`--request-summary`. The command response stays on stdout while a compact JSON
summary of method, path, status, request id, trace context, cost, token count,
cache status, maturity, and duration is written to stderr.
On nonzero exits, stderr includes the formatted error before the summary JSON.

```bash
secapi health --request-summary
```

Run `secapi doctor` when local setup is suspect. It reports the active base URL,
credential source names, API health, authenticated account context when
available, and the hosted MCP URL without printing credential values.

Run `secapi config show` when you only need the local CLI configuration. It
prints the active base URL, source names for configured credentials, and hosted
MCP URL without reading stdin, calling the API, or printing credential values.

Run `secapi config profiles` to list configured profiles, normalized base URLs,
credential environment variable names, and whether each referenced env var is
currently set. It is also local-only and never prints credential values.

Install shell completions by printing the script for your shell and wiring it
into that shell's normal completion loader:

```bash
mkdir -p ~/.zfunc && secapi completion zsh > ~/.zfunc/_secapi
echo 'fpath=(~/.zfunc $fpath); autoload -Uz compinit; compinit' >> ~/.zshrc

secapi completion bash > ~/.secapi-completion.bash
echo 'source ~/.secapi-completion.bash' >> ~/.bashrc

mkdir -p ~/.config/fish/completions
secapi completion fish > ~/.config/fish/completions/secapi.fish
```

## Five-minute Quickstart

Start local, then run five copy-paste API examples that exercise the core
surfaces:

```bash
secapi examples
secapi examples --json=false
```

The API examples read
`SECAPI_API_KEY` from the environment — credentials are never accepted as
argv flags (they leak through shell history); pipe them via `--api-key-stdin`
if you cannot set an env var.

Account-oriented commands keep JSON as the default for pipes and agents. In an
interactive terminal they render compact human summaries; pass `--json=false`
when you want that same summary explicitly:

```bash
secapi me --json=false
secapi billing show --json=false
secapi usage show --json=false
secapi limits show --json=false
```

```bash
# 1. Confirm auth and see your plan/limits
secapi me

# 2. Pull the latest 10-K for a ticker
secapi filings latest --ticker AAPL --form 10-K

# 3. Full-text search filing content (Typesense)
secapi search fulltext --q "supply chain disruption" --form 10-K --limit 10

# 4. Hybrid semantic search with citation fields (Voyage AI + Pinecone)
secapi search semantic --q "revenue concentration risk" --ticker AAPL --mode hybrid --view agent

# 5. A single XBRL fact across filings
secapi facts get --ticker AAPL --tag Assets --form 10-K
```

`secapi examples` is local-only. It prints a structured starter catalog by
default and a concise human version with `--json=false`. Portfolio and model
workflow examples include reusable `holdings.json`, `benchmark.json`, and
`model.json` templates so you can avoid fragile inline shell JSON.

## Trace Hydration

When filing-derived or source-backed responses include a trace reference, use
the CLI to hydrate the trace without switching back to curl or an SDK script.

```bash
# Resolve one trace id
secapi traces get --trace-id trc_...

# Batch resolve up to 50 trace ids
secapi traces list --ids trc_1,trc_2
```

## Search

```bash
# Keyword/full-text search across filing + section text
secapi search fulltext --q "going concern" --ticker BBBB --limit 25

# Vector / hybrid semantic search; --view agent drops score + retrievalMode
secapi search semantic --q "material weakness in internal controls" --mode hybrid --filing-year 2025

# Section-scoped keyword search
secapi sections search --ticker AAPL --q risk --form 10-K
```

## Factor Quickstart

Use `--response-mode compact` when you are feeding an agent, LLM, notebook, or UI card and want the smallest useful payload. Add `--include trust` when you need freshness, methodology, and materialization metadata for citations or launch checks. Compact catalog responses still include readiness/proof summaries for catalog/tool-discovery calls, while the full trust/provenance envelope plus full methodology/materialization/revision/source-rights objects are available when auditors need them. The full trust envelope can be larger than a simple picker payload, so prefer compact mode for interactive discovery and expand only when you need citation-grade provenance.

```bash
# Factor catalog for picker UIs and agent tool discovery
secapi factors catalog --category style --response-mode compact --include trust

# 1D through MAX style return history for charts and tables
secapi factors history --factor VALUE --range 1y --response-mode compact --include trust,series

# Factor opportunity screen for valuation-led workflows
secapi factors valuations \
  --keys VALUE,QUALITY,MOMENTUM \
  --side all \
  --sort opportunity_score \
  --limit 25 \
  --response-mode compact \
  --include trust

# Extreme moves and pairs for dashboard surfaces
secapi factors dashboard --country US --category style --ticker AAPL --response-mode compact --include trust
secapi factors extreme-moves --category style --window 1d --min-z-score 2 --response-mode compact --include trust
secapi factors extreme-pairs --category style --window 1m --min-z-score 1 --response-mode compact --include trust
```

## Portfolio Factor Workflows

Portfolio and model workflows accept JSON because they carry holdings and constraints.

```bash
cat > holdings.json <<'JSON'
[
  { "symbol": "AAPL", "weight": 0.4 },
  { "symbol": "MSFT", "weight": 0.35 },
  { "symbol": "NVDA", "weight": 0.25 }
]
JSON

secapi portfolio analyze \
  --holdings-file holdings.json \
  --response-mode compact \
  --include trust

secapi portfolio attribution \
  --holdings-file holdings.json \
  --window 1y \
  --frequency monthly \
  --response-mode compact \
  --include trust

secapi portfolio hedge \
  --holdings-file holdings.json \
  --objective factor_neutral \
  --constraints-json '{"maxHedges":5}' \
  --response-mode compact \
  --include trust

secapi portfolio optimize \
  --holdings-file holdings.json \
  --objective regime_aware \
  --constraints-json '{"longOnly":true,"maxPositionWeight":0.35}' \
  --response-mode compact \
  --include trust
```

## Model Workflows

```bash
secapi models factor-analysis \
  --holdings-file holdings.json \
  --model-json '{"id":"growth-core","label":"Growth Core"}' \
  --include-attribution \
  --include-hedge \
  --include-optimizer \
  --response-mode compact \
  --include trust
```

## Discovery

```bash
secapi --help
secapi factors catalog --category style
secapi factors bulk-download --keys VALUE,QUALITY,MOMENTUM --format csv
secapi factors similarity-pack --symbol AAPL --limit 10
secapi model-portfolios factor-view --portfolio-id growth-core --response-mode compact
```

## Links

- [API Documentation](https://docs.secapi.ai)
- [Developer Portal](https://secapi.ai/developers)
