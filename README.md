# SEC API CLI

Command-line interface for SEC API factor data, SEC filings, financial statements, ownership data, and agent workflows.

## Installation

```bash
npm install -g @secapi/cli
```

## Configuration

```bash
export SECAPI_API_KEY="ods_..."
export SECAPI_BASE_URL="https://api.secapi.ai"
```

`SECAPI_BASE_URL` is optional. The CLI defaults to `https://api.secapi.ai`.

Two binaries are installed: the preferred `secapi` and the compatibility alias `omni-sec`.

```bash
secapi --version   # prints the bare package version, e.g. 0.4.0
secapi --help      # lists every command group
```

## Five-minute Quickstart

Five copy-paste examples that exercise the core surfaces. Each reads
`SECAPI_API_KEY` from the environment — credentials are never accepted as
argv flags (they leak through shell history); pipe them via `--api-key-stdin`
if you cannot set an env var.

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

Use `--response-mode compact` when you are feeding an agent, LLM, notebook, or UI card and want the smallest useful payload. Add `--include trust` when you need freshness, methodology, and materialization metadata for citations or launch checks.

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
