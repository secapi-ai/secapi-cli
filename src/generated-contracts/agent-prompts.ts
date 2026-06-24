/**
 * Agent prompt library (OMNI-3085).
 *
 * 60 entries across 5 customer personas, 50 v1 + 10 v2-pending. The library
 * is the single source of truth shared by:
 *   - Mintlify docs (`apps/docs/content/agents/prompt-library/<persona>.md`)
 *   - Persona vertical pages (`<Prompt>` block at the bottom of each
 *     `apps/docs/content/for-<persona>.md` mirrors the position-#1 prompt)
 *   - CLI (`secapi agents prompts list/read/copy`)
 *   - Validation gates (`scripts/validate/check_agent_prompt_library.ts` and
 *     `scripts/validate/check_agent_prompt_live.ts`)
 *
 * Each `expectedToolChain` step references a tool name from
 * `services/datastream-api/src/routes/mcp.ts:TOOL_DEFINITIONS`. The structural
 * validator parses that source file at validate-time and rejects unknown tool
 * names, missing required parameters, and topic-key mismatches against the
 * `intelligence.footnotes` enum (`lease, tax, revenue, debt_covenant,
 * segment` — defined in `services/datastream-api/src/lib/footnote-intelligence.ts`).
 *
 * v2-pending entries reference tool names that do not exist yet (e.g.
 * `dilution.warrants_query`, `events.enforcement`). They ship typed in the
 * library so the back-fill PR (when OMNI-3071/3079/3087 + AAER MCP wrap merge)
 * is a single status flip per entry, not a contract migration. The validator
 * skips tool-existence checks for `status: "v2-pending"`.
 */

export const AGENT_PROMPT_PERSONAS = [
  "law-firm",
  "investment-manager",
  "sophisticated-investor",
  "insurance",
  "pr-firm",
] as const

export type AgentPromptPersona = (typeof AGENT_PROMPT_PERSONAS)[number]

export type AgentPromptStatus = "v1" | "v2-pending"

export type AgentPromptToolStep = {
  /** Tool name. Must match TOOL_DEFINITIONS.name in routes/mcp.ts for v1 entries. */
  tool: string
  /** Single-line "why this step" description. */
  purpose: string
  /** Optional sample arguments — keys validate against the tool's input schema. */
  exampleArgs?: Record<string, unknown>
}

export type AgentPrompt = {
  /** Stable kebab-case slug. Convention: `<persona>-<workflow>`. Unique across the library. */
  id: string
  persona: AgentPromptPersona
  status: AgentPromptStatus
  /** Headline shown in nav, cards, and CLI list output. */
  title: string
  /** Workflow grouping within a persona page. */
  category: string
  /** 1-sentence pitch. */
  oneLiner: string
  /** Full copy-paste prompt body. */
  prompt: string
  /** ≥3 distinct tools for v1 entries. v2-pending entries may reference future tools. */
  expectedToolChain: AgentPromptToolStep[]
  /** Output artifact description (memo, table, JSON export, risk-score rubric, etc). */
  expectedOutput: string
  /** Optional caveats or known limitations the agent should surface. */
  caveats?: string[]
  difficulty: "starter" | "intermediate" | "advanced"
  /** For v2-pending: Linear ticket IDs blocking the entry from going live. */
  blockedBy?: string[]
}

export type PersonaDisplayMeta = {
  displayName: string
  slug: AgentPromptPersona
  summary: string
  /** Optional note for the persona index page header — surfaces v1 framing vs v2 expansion. */
  framingNote?: string
}

export const PERSONA_DISPLAY: Record<AgentPromptPersona, PersonaDisplayMeta> = {
  "law-firm": {
    displayName: "Law firm",
    slug: "law-firm",
    summary:
      "Disclosure forensics, deal diligence, enforcement research, and litigation binder workflows for legal teams advising on public-company matters.",
  },
  "investment-manager": {
    displayName: "Investment manager",
    slug: "investment-manager",
    summary:
      "Quant research, factor decomposition, 13F-vs-insider divergence, and earnings-context workflows for portfolio managers and analysts.",
  },
  "sophisticated-investor": {
    displayName: "Sophisticated investor",
    slug: "sophisticated-investor",
    summary:
      "Forensic accounting and insider surveillance for activist, short-thesis, and prosumer analyst workflows.",
    framingNote:
      "v1 framing: forensic accounting (footnote forensics + insider/13F divergence + cash-flow stress). v2 expansion adds dilution forensics (warrants, convertibles, ATM-program tracking, cash runway) as the API surface expands.",
  },
  insurance: {
    displayName: "Insurance & risk",
    slug: "insurance",
    summary:
      "D&O underwriting profile, auditor-change detection, material-weakness scans, and renewal-book monitoring for risk and underwriting teams.",
    framingNote:
      "v1 framing: D&O profile via comp/13F/insider stack + keyword-search auditor changes + semantic material-weakness. v2 expansion adds typed AAER enrichment, typed auditor-change events, Form 144 monitoring, and subsidiaries discovery once supporting MCP tools merge.",
  },
  "pr-firm": {
    displayName: "PR firm",
    slug: "pr-firm",
    summary:
      "Proxy-season narrative, 8-K material event monitoring, executive transition tracking, and peer benchmarking for IR and crisis-comms teams.",
  },
}

export const AGENT_PROMPT_LIBRARY: readonly AgentPrompt[] = [
  // ----------------------------------------------------------------------------
  // INVESTMENT-MANAGER (12 v1)
  // ----------------------------------------------------------------------------
  {
    id: "investment-manager-factor-decomposition",
    persona: "investment-manager",
    status: "v1",
    title: "Decompose portfolio factor exposures with intelligence overlay",
    category: "Factor research",
    oneLiner:
      "Pull factor exposures and overlay security intelligence for a portfolio or watchlist.",
    prompt:
      "You are an investment research agent with access to SEC API. For any portfolio or watchlist of US equities, pull a security-intelligence bundle for each name, run factor exposure decomposition (momentum, value, quality, low-volatility, size), compare quarter-over-quarter 13F ownership changes for key institutional holders, and flag material insider transactions from the past 90 days. Output a per-name memo with factor weights, top three institutional rotations, top three insider clusters, and one paragraph of analyst commentary. Always cite requestId and provenance for every figure.",
    expectedToolChain: [
      { tool: "portfolio.analyze", purpose: "Compute portfolio-level factor weights and country exposure", exampleArgs: { holdings: [{ symbol: "AAPL", weight: 0.3 }, { symbol: "MSFT", weight: 0.4 }, { symbol: "NVDA", weight: 0.3 }], country: "US" } },
      { tool: "factors.decomposition", purpose: "Decompose per-security factor loadings", exampleArgs: { symbol: "AAPL", lookback: 252 } },
      { tool: "owners.compare_13f", purpose: "Quarter-over-quarter institutional rotation per name", exampleArgs: { cik: "0001067983" } },
      { tool: "insiders.list", purpose: "Recent Form 4 insider transactions per name", exampleArgs: { ticker: "AAPL", limit: 20 } },
    ],
    expectedOutput: "Per-name research memo (markdown) with factor weights, institutional rotations, insider clusters, and requestId citations.",
    difficulty: "advanced",
  },
  {
    id: "investment-manager-13f-quarterly-rotation",
    persona: "investment-manager",
    status: "v1",
    title: "Compare 13F holdings quarter-over-quarter for smart-money rotation",
    category: "Ownership intelligence",
    oneLiner:
      "Identify quarter-over-quarter institutional rotation across an institutional holder's portfolio.",
    prompt:
      "For Berkshire Hathaway (CIK 0001067983), pull the latest 13F holdings, compare against the previous quarter, surface the top ten new positions, top ten exits, and top ten size changes. For each surfaced ticker, fetch the latest insider transactions to triangulate manager conviction. Output a markdown table with ticker, position delta (shares + dollars), insider-buy ratio, and a one-line interpretation per row.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Canonicalize the holder identifier", exampleArgs: { cik: "0001067983" } },
      { tool: "owners.get_13f", purpose: "Latest holdings snapshot", exampleArgs: { cik: "0001067983", limit: 50 } },
      { tool: "owners.compare_13f", purpose: "Quarter-over-quarter delta", exampleArgs: { cik: "0001067983" } },
      { tool: "insiders.list", purpose: "Cross-validate with insider activity per surfaced ticker", exampleArgs: { ticker: "AAPL", limit: 10 } },
    ],
    expectedOutput: "Markdown table of top 30 rotations with insider-buy ratio and one-line interpretation each.",
    difficulty: "intermediate",
  },
  {
    id: "investment-manager-related-stocks-screen",
    persona: "investment-manager",
    status: "v1",
    title: "Build a factor-similar peer set with momentum and quality overlays",
    category: "Screening",
    oneLiner:
      "Generate a factor-similar peer set and rank by momentum/quality overlay.",
    prompt:
      "For NVDA, generate the closest 25 factor-similar US tickers, decompose each candidate's factor exposure, and rank by composite momentum + quality score. Pull each candidate's trailing-twelve-month financial ratios for valuation context. Output a ranked table with ticker, momentum score, quality score, P/E, ROIC, and a one-line thesis on why the peer is worth tracking.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve the seed symbol", exampleArgs: { ticker: "NVDA" } },
      { tool: "factors.related_stocks", purpose: "Factor-similar peer set", exampleArgs: { symbol: "NVDA", limit: 25 } },
      { tool: "factors.decomposition", purpose: "Per-candidate factor weights", exampleArgs: { symbol: "AMD", lookback: 252 } },
      { tool: "companies.ratios", purpose: "TTM valuation/quality ratios per candidate", exampleArgs: { ticker: "AMD", period: "annual", limit: 1 } },
    ],
    expectedOutput: "Ranked markdown table of 25 candidates with factor scores, valuation ratios, and one-line thesis per row.",
    difficulty: "intermediate",
  },
  {
    id: "investment-manager-regime-aware-screen",
    persona: "investment-manager",
    status: "v1",
    title: "Run a macro-regime-aware factor screen",
    category: "Macro overlay",
    oneLiner:
      "Pick factors aligned with the current macro regime and screen a watchlist accordingly.",
    prompt:
      "Pull the current US macro regime classification, surface the top three factor returns trailing 90 days, then screen my watchlist of large-cap US tech names against the regime-favored factors. Output a ranked list of names that align with the regime, including factor weights and a one-paragraph regime-context narrative for the brief.",
    expectedToolChain: [
      { tool: "macro.regimes", purpose: "Current regime classification", exampleArgs: { country: "US", lookback: 252 } },
      { tool: "macro.high_signal_pack", purpose: "Top macro indicator pack for regime context", exampleArgs: { country: "US" } },
      { tool: "factors.dashboard", purpose: "Factor returns aligned with regime", exampleArgs: { country: "US", category: "momentum", lookback: 90 } },
      { tool: "portfolio.analyze", purpose: "Apply factor weights to candidate portfolio", exampleArgs: { holdings: [{ symbol: "AAPL", weight: 0.5 }, { symbol: "NVDA", weight: 0.5 }], country: "US" } },
    ],
    expectedOutput: "Ranked screen of regime-aligned names + 1-paragraph regime narrative.",
    difficulty: "advanced",
  },
  {
    id: "investment-manager-earnings-context-pack",
    persona: "investment-manager",
    status: "v1",
    title: "Build an earnings-preview context pack",
    category: "Earnings prep",
    oneLiner:
      "Compile estimates, recent fundamentals, and the latest MD&A excerpt before an earnings print.",
    prompt:
      "For AAPL ahead of next earnings, pull the consensus estimates, the trailing four quarters of income statement, and the most recent MD&A section from the last 10-Q. Identify the three biggest estimate-vs-actual gaps from the prior quarter and surface MD&A passages that explain them. Output a one-page brief with bullets for setup, key debate, and watch-points.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve to canonical CIK", exampleArgs: { ticker: "AAPL" } },
      { tool: "market.estimates", purpose: "Analyst consensus estimates", exampleArgs: { ticker: "AAPL", limit: 10 } },
      { tool: "companies.income_statements", purpose: "Trailing four quarters", exampleArgs: { ticker: "AAPL", period: "quarterly", limit: 4 } },
      { tool: "sections.get", purpose: "Latest MD&A from 10-Q", exampleArgs: { ticker: "AAPL", form: "10-Q", sectionKey: "item_2" } },
    ],
    expectedOutput: "1-page earnings brief with setup, debate, watch-points.",
    difficulty: "starter",
  },
  {
    id: "investment-manager-multi-period-fundamental-trend",
    persona: "investment-manager",
    status: "v1",
    title: "Pull 5-year fundamental trends for thesis validation",
    category: "Fundamentals",
    oneLiner:
      "Walk five years of revenue, margins, cash conversion, and ratios for a name.",
    prompt:
      "For MSFT, pull five years of annual income statement, balance sheet, cash flow statement, and key ratios. Surface a year-over-year delta table for revenue, gross margin, operating margin, free cash flow, ROIC, and net debt/EBITDA. Highlight any year where two or more metrics inflected by more than 20 percent and ask the agent to hypothesize the driver.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve to canonical CIK", exampleArgs: { ticker: "MSFT" } },
      { tool: "companies.income_statements", purpose: "5-year income trend", exampleArgs: { ticker: "MSFT", period: "annual", limit: 5 } },
      { tool: "companies.cash_flow_statements", purpose: "5-year cash flow trend", exampleArgs: { ticker: "MSFT", period: "annual", limit: 5 } },
      { tool: "companies.ratios", purpose: "5-year ratios trend", exampleArgs: { ticker: "MSFT", period: "annual", limit: 5 } },
    ],
    expectedOutput: "Year-over-year delta table + hypothesized drivers for inflection years.",
    difficulty: "starter",
  },
  {
    id: "investment-manager-intelligence-bundle-grounded",
    persona: "investment-manager",
    status: "v1",
    title: "Generate a security intelligence bundle with footnote citations",
    category: "Issuer brief",
    oneLiner:
      "Produce a citation-grounded company intelligence bundle for an allocator brief.",
    prompt:
      "For TSLA, build a company intelligence brief that combines the latest semantic intelligence query (covering valuation, governance, and risk), the most recent debt-covenant footnote, the latest segment-revenue footnote, and the latest balance sheet snapshot. Output a markdown brief with three sections (signal, balance-sheet posture, footnote red-flags) and inline citations to filing URLs.",
    expectedToolChain: [
      { tool: "intelligence.query", purpose: "Top-of-funnel semantic signal", exampleArgs: { query: "TSLA capital structure governance debate", entities: ["TSLA"] } },
      { tool: "intelligence.footnotes", purpose: "Debt-covenant + segment footnotes", exampleArgs: { ticker: "TSLA", form: "10-K", topics: ["debt_covenant", "segment"] } },
      { tool: "sections.get", purpose: "Item 7 MD&A passages for context", exampleArgs: { ticker: "TSLA", form: "10-K", sectionKey: "item_7" } },
      { tool: "companies.balance_sheets", purpose: "Most recent balance sheet snapshot", exampleArgs: { ticker: "TSLA", period: "quarterly", limit: 1 } },
    ],
    expectedOutput: "Markdown brief with 3 sections + inline filing URL citations.",
    difficulty: "intermediate",
  },
  {
    id: "investment-manager-portfolio-stress-test",
    persona: "investment-manager",
    status: "v1",
    title: "Stress-test portfolio against macro regimes",
    category: "Risk",
    oneLiner:
      "Project portfolio factor returns across alternative macro regimes.",
    prompt:
      "Take my current portfolio (NVDA 30%, AAPL 25%, MSFT 25%, GOOGL 20%), run portfolio.analyze for current factor exposures, then pull factor returns under the prevailing regime AND the prior 12-month regime. Build a stress table comparing realized portfolio returns under each regime and surface the two factors with the largest swing. Output a one-page risk note for the IC.",
    expectedToolChain: [
      { tool: "portfolio.analyze", purpose: "Current portfolio factor exposures", exampleArgs: { holdings: [{ symbol: "NVDA", weight: 0.3 }, { symbol: "AAPL", weight: 0.25 }, { symbol: "MSFT", weight: 0.25 }, { symbol: "GOOGL", weight: 0.2 }], country: "US" } },
      { tool: "macro.regimes", purpose: "Current and prior regimes", exampleArgs: { country: "US", lookback: 504 } },
      { tool: "factors.returns", purpose: "Factor returns under each regime", exampleArgs: { keys: ["momentum", "quality", "value"], window: 21, lookback: 252 } },
      { tool: "factors.dashboard", purpose: "Cross-regime factor comparison", exampleArgs: { country: "US", category: "momentum", window: 21, lookback: 252 } },
    ],
    expectedOutput: "1-page IC risk note with stress table + 2-factor swing commentary.",
    difficulty: "advanced",
  },
  {
    id: "investment-manager-insider-13f-divergence",
    persona: "investment-manager",
    status: "v1",
    title: "Spot insider buying that contradicts institutional rotation",
    category: "Smart-money signals",
    oneLiner:
      "Find names where insiders are buying while institutions are selling.",
    prompt:
      "For my watchlist of small-cap US healthcare names, identify any tickers where insiders have been net buyers in the past 90 days while one or more 13F filers have been net sellers in the latest quarter. For each match, surface the top insider buyers (Form 4) and the top institutional sellers, plus the latest 90-day insider net-buy dollar volume and the institutional position delta in shares. Output a table ranked by signal strength.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve each ticker", exampleArgs: { ticker: "MULN" } },
      { tool: "insiders.list", purpose: "90-day insider transaction history", exampleArgs: { ticker: "MULN", limit: 50 } },
      { tool: "owners.get_13f", purpose: "Latest institutional snapshot per ticker", exampleArgs: { cik: "0000789019" } },
      { tool: "owners.compare_13f", purpose: "Quarter-over-quarter institutional delta", exampleArgs: { cik: "0000789019" } },
    ],
    expectedOutput: "Ranked table of divergence candidates with insider $ + institutional Δshares.",
    difficulty: "intermediate",
  },
  {
    id: "investment-manager-comp-aligned-incentives",
    persona: "investment-manager",
    status: "v1",
    title: "Audit executive compensation alignment with shareholder returns",
    category: "Governance",
    oneLiner:
      "Compare named-executive compensation against TSR + market context.",
    prompt:
      "For META, pull the latest named-executive compensation disclosures and the prior year's compensation, compare year-over-year base + equity + total, then overlay trailing 12-month total shareholder return and the latest market financials. Output an alignment scorecard (0-10) with bullets on (a) pay-for-performance correlation, (b) equity grant timing relative to drawdowns, (c) any outlier comp items vs peers.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve to canonical CIK", exampleArgs: { ticker: "META" } },
      { tool: "comp.list", purpose: "Latest named-executive comp", exampleArgs: { ticker: "META", limit: 10 } },
      { tool: "comp.compare", purpose: "Year-over-year comp comparison", exampleArgs: { ticker: "META", limit: 10 } },
      { tool: "market.financials", purpose: "TSR + price context", exampleArgs: { ticker: "META", timeframe: "annual", limit: 3 } },
    ],
    expectedOutput: "Alignment scorecard 0-10 with 3 bullets and supporting figures.",
    difficulty: "intermediate",
  },
  {
    id: "investment-manager-segment-revenue-forensics",
    persona: "investment-manager",
    status: "v1",
    title: "Decompose segment revenue trajectories",
    category: "Fundamentals",
    oneLiner:
      "Walk segment revenue + segment-disclosure footnotes for a diversified issuer.",
    prompt:
      "For AMZN, pull the segment-revenue disclosure footnote (intelligence.footnotes topic=segment), align with the latest annual income statement segment columns, and walk five years of segment-mix shift. Surface the segment with the largest absolute growth, the segment with the largest margin compression, and the latest 10-K Item 8 segment table excerpt. Output a markdown narrative + segment-mix waterfall.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve to canonical CIK", exampleArgs: { ticker: "AMZN" } },
      { tool: "intelligence.footnotes", purpose: "Segment-disclosure footnotes", exampleArgs: { ticker: "AMZN", form: "10-K", topics: ["segment"] } },
      { tool: "companies.income_statements", purpose: "5-year segmented income", exampleArgs: { ticker: "AMZN", period: "annual", limit: 5 } },
      { tool: "sections.get", purpose: "Item 8 financial-statement segment narrative", exampleArgs: { ticker: "AMZN", form: "10-K", sectionKey: "item_8" } },
    ],
    expectedOutput: "Markdown narrative + segment-mix waterfall covering 5 years.",
    difficulty: "advanced",
  },
  {
    id: "investment-manager-macro-tilt-recommendation",
    persona: "investment-manager",
    status: "v1",
    title: "Recommend macro tilts based on cross-country regime divergence",
    category: "Macro overlay",
    oneLiner:
      "Compare regimes across major markets and recommend country/factor tilts.",
    prompt:
      "Compare current macro regime classifications across US, Eurozone, Japan, and emerging markets. For each market, pull the latest high-signal indicator pack and the prevailing-regime factor returns. Recommend a country/factor tilt allocation with one paragraph of evidence per market. Output a tilt table + 4-paragraph rationale.",
    expectedToolChain: [
      { tool: "macro.regimes", purpose: "Per-country regime classifications", exampleArgs: { country: "US", lookback: 252 } },
      { tool: "macro.indicators", purpose: "Recent indicator history per country", exampleArgs: { country: "US", indicatorKey: "industrial_production", limit: 12 } },
      { tool: "macro.high_signal_pack", purpose: "Top-of-stack indicators per country", exampleArgs: { country: "US" } },
      { tool: "portfolio.analyze", purpose: "Apply tilts to a baseline portfolio", exampleArgs: { holdings: [{ symbol: "SPY", weight: 0.4 }, { symbol: "EFA", weight: 0.3 }, { symbol: "EEM", weight: 0.3 }], country: "US" } },
    ],
    expectedOutput: "Country/factor tilt table + 4-paragraph rationale.",
    difficulty: "advanced",
  },

  // ----------------------------------------------------------------------------
  // LAW-FIRM (12 v1)
  // ----------------------------------------------------------------------------
  {
    id: "law-firm-enforcement-history",
    persona: "law-firm",
    status: "v1",
    title: "Build a 12-month enforcement and disclosure dossier for a client target",
    category: "Enforcement research",
    oneLiner:
      "Compile 12 months of filings, legal proceedings, and insider activity for due diligence.",
    prompt:
      "You are a legal research assistant with access to SEC API. For any client target company, resolve the entity to a canonical CIK, pull the past 12 months of filings (8-K, 10-K, 10-Q, DEF 14A), extract the legal-proceedings section (Item 3) from the most recent 10-K, list insider trading activity from the past 12 months, and surface any 8-K Item 5.02 (officer/director departures) events. Output a dossier with one section per finding category and inline requestId references for auditability.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Canonicalize the target to a CIK", exampleArgs: { ticker: "WFC" } },
      { tool: "filings.search", purpose: "12-month filing history", exampleArgs: { ticker: "WFC", limit: 50 } },
      { tool: "sections.get", purpose: "Item 3 legal proceedings from latest 10-K", exampleArgs: { ticker: "WFC", form: "10-K", sectionKey: "item_3" } },
      { tool: "insiders.list", purpose: "12-month insider transaction history", exampleArgs: { ticker: "WFC", limit: 50 } },
    ],
    expectedOutput: "Disclosure dossier (markdown) with 4 sections + inline requestId citations.",
    difficulty: "intermediate",
  },
  {
    id: "law-firm-deal-disclosure-diligence",
    persona: "law-firm",
    status: "v1",
    title: "Diligence the latest 8-K material agreement for an M&A target",
    category: "Deal diligence",
    oneLiner:
      "Pull the most recent 8-K Item 1.01 material agreement and produce a litigation-ready PDF.",
    prompt:
      "For an M&A target (e.g., MSFT), find the most recent 8-K filing that contains an Item 1.01 (Entry into a Material Definitive Agreement) section. Extract the full Item 1.01 text, render the 8-K as a citation-friendly markdown document, and export it as a PDF for the deal binder. Surface the counterparty, agreement type, and any termination/material-adverse-change clauses identified.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve target to CIK", exampleArgs: { ticker: "MSFT" } },
      { tool: "filings.search", purpose: "Find recent 8-K filings", exampleArgs: { ticker: "MSFT", form: "8-K", limit: 10 } },
      { tool: "sections.get", purpose: "Extract Item 1.01 text", exampleArgs: { ticker: "MSFT", form: "8-K", sectionKey: "item_1_01" } },
      { tool: "filings.export", purpose: "Render 8-K to PDF for the binder", exampleArgs: { accessionNumber: "0000950170-24-012345", format: "pdf" } },
    ],
    expectedOutput: "Item 1.01 extract + rendered 8-K PDF (base64) + counterparty/clause summary.",
    difficulty: "intermediate",
  },
  {
    id: "law-firm-proxy-fight-vote-analysis",
    persona: "law-firm",
    status: "v1",
    title: "Reconstruct proxy fight outcomes for governance precedent",
    category: "Governance research",
    oneLiner:
      "Pull voting results, comp context, and 8-K Item 5.07 narrative for a contested proxy.",
    prompt:
      "For a contested proxy fight (e.g., DIS 2023, ETSY 2024), pull the events.voting_results record for the most recent annual meeting, list all proposals and their vote tallies, surface the named-executive comp from the same DEF 14A cycle, and extract the 8-K Item 5.07 (Submission of Matters to a Vote of Security Holders) text. Output a precedent memo with proposal-by-proposal outcomes, comp context, and any director-vote outliers.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve issuer", exampleArgs: { ticker: "DIS" } },
      { tool: "events.voting_results", purpose: "Latest annual meeting tally", exampleArgs: { ticker: "DIS", meeting_type: "annual", limit: 5 } },
      { tool: "comp.list", purpose: "Named-executive comp same cycle", exampleArgs: { ticker: "DIS", limit: 10 } },
      { tool: "sections.get", purpose: "Item 5.07 8-K narrative", exampleArgs: { ticker: "DIS", form: "8-K", sectionKey: "item_5_07" } },
    ],
    expectedOutput: "Precedent memo (markdown) with proposal tallies + comp context + outliers.",
    difficulty: "advanced",
  },
  {
    id: "law-firm-restatement-detection",
    persona: "law-firm",
    status: "v1",
    title: "Surface restatements and material-weakness disclosures across a watchlist",
    category: "Disclosure forensics",
    oneLiner:
      "Search a watchlist for 10-K/A restatements + Item 9A material-weakness language.",
    prompt:
      "For a watchlist of small-cap US issuers, find any 10-K/A (amended annual reports) filed in the past 24 months. For each match, search sections for the keyword 'restatement' and pull Item 9A (Controls and Procedures) text from the underlying 10-K. Surface the type of restatement, the period restated, and any material-weakness disclosure language. Output a ranked table by severity.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve each ticker", exampleArgs: { ticker: "MULN" } },
      { tool: "filings.search", purpose: "10-K/A filing history", exampleArgs: { ticker: "MULN", form: "10-K/A", limit: 10 } },
      { tool: "sections.search", purpose: "Find restatement language", exampleArgs: { ticker: "MULN", q: "restatement", form: "10-K/A", limit: 5 } },
      { tool: "sections.get", purpose: "Item 9A material-weakness text", exampleArgs: { ticker: "MULN", form: "10-K", sectionKey: "item_9a" } },
    ],
    expectedOutput: "Severity-ranked table of restatements + material-weakness disclosures.",
    caveats: [
      "Material-weakness detection is keyword-based on Item 9A text. Typed AAER classification ships in v2 with the AAER MCP wrap.",
    ],
    difficulty: "advanced",
  },
  {
    id: "law-firm-litigation-binder-export",
    persona: "law-firm",
    status: "v1",
    title: "Export a litigation binder of filings as PDF + DOCX",
    category: "Litigation support",
    oneLiner:
      "Produce a multi-format binder of relevant filings for a litigation matter.",
    prompt:
      "For a defendant company, pull the most recent 10-K, the most recent two 10-Qs, and any 8-K from the past 12 months that contains an Item 8.01 (Other Events) disclosure. Export each as both PDF (binder copy) and DOCX (markup-ready). Save accession numbers and provenance for the chain-of-custody log.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve defendant", exampleArgs: { ticker: "WFC" } },
      { tool: "filings.search", purpose: "Find target filings", exampleArgs: { ticker: "WFC", limit: 20 } },
      { tool: "filings.export", purpose: "PDF binder copy", exampleArgs: { accessionNumber: "0000072971-24-000045", format: "pdf" } },
      { tool: "filings.export", purpose: "DOCX markup-ready copy", exampleArgs: { accessionNumber: "0000072971-24-000045", format: "docx" } },
    ],
    expectedOutput: "Set of binder files (base64) + chain-of-custody log table.",
    difficulty: "starter",
  },
  {
    id: "law-firm-officer-departure-monitoring",
    persona: "law-firm",
    status: "v1",
    title: "Track officer departures across a portfolio of insureds",
    category: "Event monitoring",
    oneLiner:
      "Detect 8-K Item 5.02 officer departures for D&O claim-prevention monitoring.",
    prompt:
      "For a portfolio of 50 insured public companies, search the past 90 days of 8-K filings for any Item 5.02 (Departure of Directors or Certain Officers) disclosure. For each match, extract the Item 5.02 text, pull the executive's most recent compensation, and list the insider's recent Form 4 trading activity. Output a ranked alert list by claim-trigger likelihood.",
    expectedToolChain: [
      { tool: "filings.search", purpose: "Recent 8-K filings", exampleArgs: { form: "8-K", limit: 100 } },
      { tool: "sections.search", purpose: "Find Item 5.02 disclosures", exampleArgs: { form: "8-K", q: "resignation appointment", limit: 50 } },
      { tool: "sections.get", purpose: "Extract Item 5.02 text per match", exampleArgs: { ticker: "WFC", form: "8-K", sectionKey: "item_5_02" } },
      { tool: "insiders.list", purpose: "Departing executive's recent trades", exampleArgs: { ticker: "WFC", limit: 20 } },
    ],
    expectedOutput: "Ranked alert list with Item 5.02 text + comp + trading activity per departure.",
    difficulty: "intermediate",
  },
  {
    id: "law-firm-insider-trading-pattern-review",
    persona: "law-firm",
    status: "v1",
    title: "Review insider trading clusters for Section 16 compliance",
    category: "Compliance review",
    oneLiner:
      "Surface insider clusters and cross-reference with comp grants for Section 16 filings.",
    prompt:
      "For a public company you are advising, list all Form 4 insider transactions in the past 180 days, group by reporting person, surface any clusters of 3+ transactions in any 14-day window, cross-reference with the named-executive comp disclosures (DEF 14A) to identify whether transactions follow scheduled grants, and flag any sales by directors/officers above $1M. Output a Section 16 review packet.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve issuer", exampleArgs: { ticker: "ORCL" } },
      { tool: "insiders.list", purpose: "180-day insider transactions", exampleArgs: { ticker: "ORCL", limit: 100 } },
      { tool: "comp.list", purpose: "Named-executive comp + grant schedule", exampleArgs: { ticker: "ORCL", limit: 10 } },
      { tool: "owners.get_13f", purpose: "Institutional context", exampleArgs: { cik: "0001341439" } },
    ],
    expectedOutput: "Section 16 review packet with insider clusters + grant alignment + ≥$1M sales flagged.",
    difficulty: "advanced",
  },
  {
    id: "law-firm-disclosure-comparison-peer",
    persona: "law-firm",
    status: "v1",
    title: "Compare risk-factor disclosures across industry peers",
    category: "Disclosure comparison",
    oneLiner:
      "Benchmark a client's Item 1A risk factors against factor-similar peers.",
    prompt:
      "For NVDA, identify the top 10 factor-similar US peers, pull each peer's latest Item 1A (Risk Factors) section, and identify any risk-factor topics present in 7+ peers but missing from NVDA's disclosure. Output a comparison matrix + recommended risk-factor additions for the next 10-K cycle.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve subject and peers", exampleArgs: { ticker: "NVDA" } },
      { tool: "factors.related_stocks", purpose: "Factor-similar peer set", exampleArgs: { symbol: "NVDA", limit: 10 } },
      { tool: "sections.get", purpose: "Item 1A from each peer's 10-K", exampleArgs: { ticker: "AMD", form: "10-K", sectionKey: "item_1a" } },
      { tool: "intelligence.query", purpose: "Surface common risk-factor topics across the cohort", exampleArgs: { query: "common risk factors semiconductor industry 10-K", entities: ["NVDA", "AMD", "INTC"] } },
    ],
    expectedOutput: "Comparison matrix + recommended risk-factor additions.",
    difficulty: "advanced",
  },
  {
    id: "law-firm-regulatory-search-thematic",
    persona: "law-firm",
    status: "v1",
    title: "Identify cross-issuer regulatory disclosure trends",
    category: "Regulatory research",
    oneLiner:
      "Search semantically across filings for an emerging regulatory theme.",
    prompt:
      "Identify how US public companies are disclosing AI governance and data-privacy risk in their 2024 10-Ks. Run a semantic intelligence query, then for the top 10 returned issuers pull the relevant 10-K sections and the underlying filings (PDF). Output a thematic memo with three representative excerpts and a list of disclosure approaches.",
    expectedToolChain: [
      { tool: "intelligence.query", purpose: "Semantic search across 10-Ks", exampleArgs: { query: "AI governance data privacy risk factor 10-K disclosure", lookback: 365 } },
      { tool: "sections.search", purpose: "Find specific risk-factor sections", exampleArgs: { q: "artificial intelligence governance", form: "10-K", limit: 20 } },
      { tool: "filings.search", purpose: "Underlying filings inventory", exampleArgs: { form: "10-K", limit: 20 } },
      { tool: "filings.export", purpose: "PDF of representative filings", exampleArgs: { accessionNumber: "0000950170-24-012345", format: "pdf" } },
    ],
    expectedOutput: "Thematic memo with 3 excerpts + disclosure approach taxonomy.",
    difficulty: "advanced",
  },
  {
    id: "law-firm-going-concern-keyword-scan",
    persona: "law-firm",
    status: "v1",
    title: "Detect going-concern language across small-cap watchlist",
    category: "Solvency monitoring",
    oneLiner:
      "Sweep watchlist filings for substantial-doubt and going-concern language.",
    prompt:
      "For a watchlist of US micro-cap issuers, search 10-K and 10-Q filings for any occurrence of 'substantial doubt' or 'going concern' language. For each match, pull the Item 9A (Controls) section and the most recent balance sheet + cash flow snapshots to estimate runway. Output a watchlist alert table ranked by months of runway.",
    expectedToolChain: [
      { tool: "sections.search", purpose: "Going-concern language search", exampleArgs: { q: "going concern substantial doubt", form: "10-K", limit: 50 } },
      { tool: "sections.get", purpose: "Item 9A internal-controls text", exampleArgs: { ticker: "MULN", form: "10-K", sectionKey: "item_9a" } },
      { tool: "companies.balance_sheets", purpose: "Latest balance sheet for runway estimation", exampleArgs: { ticker: "MULN", period: "quarterly", limit: 1 } },
      { tool: "companies.cash_flow_statements", purpose: "Burn-rate context", exampleArgs: { ticker: "MULN", period: "quarterly", limit: 4 } },
    ],
    expectedOutput: "Runway-ranked alert table for going-concern candidates.",
    caveats: [
      "Runway computation is approximate; uses cash + ST investments / TTM operating cash burn.",
    ],
    difficulty: "intermediate",
  },
  {
    id: "law-firm-defendant-financial-baseline",
    persona: "law-firm",
    status: "v1",
    title: "Establish defendant's financial baseline for damages assessment",
    category: "Litigation support",
    oneLiner:
      "Pull a financial baseline (revenue, margins, market cap) for damages computation.",
    prompt:
      "For a defendant company, pull the most recent annual income statement, the latest balance sheet, the trailing-twelve-month revenue trajectory (last 8 quarters), and the latest market snapshot. Output a one-page financial baseline + key ratios for the damages expert.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve defendant", exampleArgs: { ticker: "WFC" } },
      { tool: "companies.financials", purpose: "Annual + quarterly fundamentals", exampleArgs: { ticker: "WFC", period: "annual", limit: 3 } },
      { tool: "companies.ratios", purpose: "Key ratios", exampleArgs: { ticker: "WFC", period: "annual", limit: 3 } },
      { tool: "market.snapshots", purpose: "Latest market snapshot", exampleArgs: { symbols: ["WFC"] } },
    ],
    expectedOutput: "1-page financial baseline + key ratios for the damages expert.",
    difficulty: "starter",
  },
  {
    id: "law-firm-d-and-o-binder",
    persona: "law-firm",
    status: "v1",
    title: "Compile D&O liability binder for a board",
    category: "D&O preparation",
    oneLiner:
      "Build a board-side D&O binder covering comp, ownership, insider activity.",
    prompt:
      "For a public-company board, compile a D&O liability binder including: most recent named-executive comp, year-over-year comp change, latest 13F institutional ownership snapshot, and the past 12 months of insider Form 4 transactions. Add a one-page narrative on governance posture.",
    expectedToolChain: [
      { tool: "comp.list", purpose: "Latest comp disclosures", exampleArgs: { ticker: "META", limit: 10 } },
      { tool: "comp.compare", purpose: "Year-over-year comp comparison", exampleArgs: { ticker: "META", limit: 10 } },
      { tool: "owners.get_13f", purpose: "Institutional ownership snapshot", exampleArgs: { cik: "0001326801" } },
      { tool: "insiders.list", purpose: "12-month Form 4 history", exampleArgs: { ticker: "META", limit: 50 } },
    ],
    expectedOutput: "D&O binder (markdown) + 1-page governance narrative.",
    difficulty: "intermediate",
  },

  // ----------------------------------------------------------------------------
  // PR-FIRM (12 v1)
  // ----------------------------------------------------------------------------
  {
    id: "pr-firm-voting-results-narrative",
    persona: "pr-firm",
    status: "v1",
    title: "Generate a proxy-season vote-results narrative for client briefings",
    category: "Proxy season",
    oneLiner:
      "Pull voting results, comp context, and peer comparison for a proxy-season recap.",
    prompt:
      "For a corporate IR client, pull the most recent annual meeting voting results, list every proposal with vote tallies and percentages, surface the named-executive comp context, and identify the top 5 factor-similar peer companies whose annual meetings ran in the same window. Output a recap memo + comparative table for the IR client briefing.",
    expectedToolChain: [
      { tool: "events.voting_results", purpose: "Voting results structured pull", exampleArgs: { ticker: "DIS", meeting_type: "annual", limit: 5 } },
      { tool: "comp.list", purpose: "Named-executive comp context", exampleArgs: { ticker: "DIS", limit: 10 } },
      { tool: "intelligence.query", purpose: "Surface narrative context for the meeting", exampleArgs: { query: "proxy season say-on-pay director election outcome", entities: ["DIS"] } },
      { tool: "factors.related_stocks", purpose: "Peer set for comparative recap", exampleArgs: { symbol: "DIS", limit: 5 } },
    ],
    expectedOutput: "Proxy-season recap memo (markdown) + comparative peer table.",
    difficulty: "intermediate",
  },
  {
    id: "pr-firm-8k-material-event-monitoring",
    persona: "pr-firm",
    status: "v1",
    title: "Monitor 8-K material events across a portfolio of clients",
    category: "Event monitoring",
    oneLiner:
      "Sweep client portfolio 8-K filings for material-event disclosures.",
    prompt:
      "For a portfolio of 25 PR clients, sweep the past 30 days of 8-K filings, search for any Item 8.01 (Other Events) disclosure that references a 'material' announcement, and pull the full text of each match. Output a daily monitoring digest with one paragraph per event and a recommended client-comms posture.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve each client to canonical CIK", exampleArgs: { ticker: "DIS" } },
      { tool: "filings.search", purpose: "Recent 8-K filings", exampleArgs: { ticker: "DIS", form: "8-K", limit: 20 } },
      { tool: "sections.search", purpose: "Find Item 8.01 material disclosures", exampleArgs: { form: "8-K", q: "material", limit: 20 } },
      { tool: "sections.get", purpose: "Extract full Item 8.01 text", exampleArgs: { ticker: "DIS", form: "8-K", sectionKey: "item_8_01" } },
    ],
    expectedOutput: "Daily monitoring digest + recommended client-comms posture per event.",
    difficulty: "intermediate",
  },
  {
    id: "pr-firm-executive-transition-detection",
    persona: "pr-firm",
    status: "v1",
    title: "Detect executive transitions for crisis-comms prep",
    category: "Crisis comms",
    oneLiner:
      "Surface 8-K Item 5.02 officer transitions and pull supporting comp + insider context.",
    prompt:
      "Sweep the past 7 days of 8-K filings for any Item 5.02 (Departure of Directors or Certain Officers) disclosure. For each match, extract the full text, identify the officer's most recent compensation, and check Form 4 trading activity in the past 30 days. Output a crisis-comms prep packet ranked by reputational risk.",
    expectedToolChain: [
      { tool: "filings.search", purpose: "Recent 8-K filings", exampleArgs: { form: "8-K", limit: 50 } },
      { tool: "sections.get", purpose: "Item 5.02 text per match", exampleArgs: { ticker: "DIS", form: "8-K", sectionKey: "item_5_02" } },
      { tool: "comp.compare", purpose: "Departing officer's comp history", exampleArgs: { ticker: "DIS", limit: 10 } },
      { tool: "insiders.list", purpose: "Recent Form 4 trades", exampleArgs: { ticker: "DIS", limit: 20 } },
    ],
    expectedOutput: "Crisis-comms prep packet with reputational-risk ranking.",
    difficulty: "intermediate",
  },
  {
    id: "pr-firm-peer-comparison-context",
    persona: "pr-firm",
    status: "v1",
    title: "Build peer-comparison context for client crisis comms",
    category: "Peer benchmarking",
    oneLiner:
      "Compare a client's financial posture against factor-similar peers for crisis prep.",
    prompt:
      "For an IR client (e.g., NFLX), generate the top 10 factor-similar peers, pull each peer's most recent annual financials and named-executive comp, and produce a comparison table. Output a crisis-comms briefing with three messages framed by where the client's metrics sit vs the peer cohort.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve client", exampleArgs: { ticker: "NFLX" } },
      { tool: "factors.related_stocks", purpose: "Factor-similar peer set", exampleArgs: { symbol: "NFLX", limit: 10 } },
      { tool: "companies.financials", purpose: "Peer fundamentals", exampleArgs: { ticker: "DIS", period: "annual", limit: 1 } },
      { tool: "comp.list", purpose: "Peer named-executive comp", exampleArgs: { ticker: "DIS", limit: 5 } },
    ],
    expectedOutput: "Peer comparison table + 3 message-framings for crisis comms.",
    difficulty: "intermediate",
  },
  {
    id: "pr-firm-quiet-period-trading-watch",
    persona: "pr-firm",
    status: "v1",
    title: "Audit insider trading during client quiet periods",
    category: "Compliance comms",
    oneLiner:
      "Surface insider trades that occurred during quiet-period windows.",
    prompt:
      "For a corporate client, list all Form 4 insider transactions in the past 90 days, identify any that occurred within 14 days of an earnings announcement (quiet period), and surface any 'trading window' or 'quiet period' language in recent filings. Output a comms advisory + compliance flags.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve client", exampleArgs: { ticker: "NFLX" } },
      { tool: "insiders.list", purpose: "90-day Form 4 transactions", exampleArgs: { ticker: "NFLX", limit: 50 } },
      { tool: "filings.search", purpose: "Recent Form 4 filings", exampleArgs: { ticker: "NFLX", form: "4", limit: 50 } },
      { tool: "sections.search", purpose: "Trading-window policy search", exampleArgs: { ticker: "NFLX", q: "trading window quiet period", limit: 5 } },
    ],
    expectedOutput: "Comms advisory + compliance flag table.",
    difficulty: "advanced",
  },
  {
    id: "pr-firm-acquisition-announcement-context",
    persona: "pr-firm",
    status: "v1",
    title: "Prep acquisition-announcement materials with deal-context lookup",
    category: "Deal comms",
    oneLiner:
      "Pull deal-context filings, comp impact, and entity profile for an acquisition press release.",
    prompt:
      "For an upcoming acquisition announcement, pull the most recent 8-K Item 1.01 (Material Definitive Agreement) for the acquirer, extract the deal terms, resolve the target entity, and pull comp comparison context for the acquirer's executives. Output a press-release ready brief with deal-terms summary, target profile, and exec-comp implications.",
    expectedToolChain: [
      { tool: "filings.search", purpose: "Find recent 8-K Item 1.01 filings", exampleArgs: { form: "8-K", q: "material agreement", limit: 10 } },
      { tool: "sections.get", purpose: "Item 1.01 deal terms", exampleArgs: { ticker: "MSFT", form: "8-K", sectionKey: "item_1_01" } },
      { tool: "entities.resolve", purpose: "Resolve target entity", exampleArgs: { name: "Activision Blizzard" } },
      { tool: "comp.compare", purpose: "Acquirer exec-comp comparison", exampleArgs: { ticker: "MSFT", limit: 10 } },
    ],
    expectedOutput: "Press-release-ready brief with deal terms + target profile + comp implications.",
    difficulty: "intermediate",
  },
  {
    id: "pr-firm-press-release-disclosure-cross-check",
    persona: "pr-firm",
    status: "v1",
    title: "Cross-check press release against latest 8-K Reg FD filing",
    category: "Reg FD compliance",
    oneLiner:
      "Validate that draft press release content aligns with latest Reg FD 8-K disclosure.",
    prompt:
      "For a client's draft press release, pull the most recent 8-K filing that includes an Item 7.01 (Reg FD Disclosure) section, render the 8-K to markdown, run a semantic comparison against the press release content, and surface any material claim in the draft that lacks 8-K corroboration. Output a Reg FD compliance review.",
    expectedToolChain: [
      { tool: "filings.search", purpose: "Find recent 8-K Item 7.01 filings", exampleArgs: { ticker: "DIS", form: "8-K", limit: 10 } },
      { tool: "sections.get", purpose: "Item 7.01 Reg FD text", exampleArgs: { ticker: "DIS", form: "8-K", sectionKey: "item_7_01" } },
      { tool: "filings.render", purpose: "Render 8-K to markdown for diff", exampleArgs: { ticker: "DIS", form: "8-K" } },
      { tool: "intelligence.query", purpose: "Semantic alignment check", exampleArgs: { query: "Reg FD disclosure consistency check", entities: ["DIS"] } },
    ],
    expectedOutput: "Reg FD compliance review with claim-by-claim alignment table.",
    difficulty: "advanced",
  },
  {
    id: "pr-firm-results-announcement-prep",
    persona: "pr-firm",
    status: "v1",
    title: "Build earnings-results announcement materials",
    category: "Earnings comms",
    oneLiner:
      "Pull estimates, results, and MD&A for an earnings press release.",
    prompt:
      "For an upcoming earnings announcement (e.g., AAPL), pull consensus estimates, the most recent 4 quarters of income statement, and the latest 8-K Item 2.02 (Results of Operations and Financial Condition) section. Output a press-release outline with the headline beat/miss framing, three supporting bullets, and a draft management quote pulled from the 8-K narrative.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve issuer", exampleArgs: { ticker: "AAPL" } },
      { tool: "market.estimates", purpose: "Consensus estimates", exampleArgs: { ticker: "AAPL", limit: 4 } },
      { tool: "companies.income_statements", purpose: "Recent quarterly income", exampleArgs: { ticker: "AAPL", period: "quarterly", limit: 4 } },
      { tool: "sections.get", purpose: "Item 2.02 results-of-operations text", exampleArgs: { ticker: "AAPL", form: "8-K", sectionKey: "item_2_02" } },
    ],
    expectedOutput: "Press-release outline with framing + 3 bullets + draft mgmt quote.",
    difficulty: "intermediate",
  },
  {
    id: "pr-firm-shareholder-meeting-narrative",
    persona: "pr-firm",
    status: "v1",
    title: "Reconstruct shareholder meeting narrative from voting record",
    category: "Proxy season",
    oneLiner:
      "Build a post-meeting narrative for IR's annual letter using voting results + comp + 8-K text.",
    prompt:
      "For a corporate IR client's most recent shareholder meeting, pull the structured voting results, named-executive comp from the same DEF 14A cycle, and the 8-K Item 5.07 (Submission of Matters to a Vote of Security Holders) text. Cross-reference with intelligence.query for any analyst or media commentary in the same window. Output a 1-page post-meeting narrative for the annual letter.",
    expectedToolChain: [
      { tool: "events.voting_results", purpose: "Structured voting outcomes", exampleArgs: { ticker: "DIS", meeting_type: "annual", limit: 5 } },
      { tool: "comp.list", purpose: "Same-cycle comp", exampleArgs: { ticker: "DIS", limit: 10 } },
      { tool: "sections.get", purpose: "Item 5.07 8-K narrative", exampleArgs: { ticker: "DIS", form: "8-K", sectionKey: "item_5_07" } },
      { tool: "intelligence.query", purpose: "External commentary signal", exampleArgs: { query: "shareholder meeting outcome analyst response", entities: ["DIS"] } },
    ],
    expectedOutput: "1-page post-meeting narrative for the IR annual letter.",
    difficulty: "intermediate",
  },
  {
    id: "pr-firm-board-composition-change",
    persona: "pr-firm",
    status: "v1",
    title: "Track board composition changes across a watchlist",
    category: "Governance comms",
    oneLiner:
      "Detect 8-K Item 5.02 board changes and pull supporting comp + ownership context.",
    prompt:
      "For a watchlist of 25 corporate clients, sweep the past 60 days of 8-K filings for Item 5.02 (officer/director departure or appointment) disclosures, extract the full text, identify the new appointee or departing director, pull comp comparison context, and check institutional ownership snapshot. Output a governance-comms digest.",
    expectedToolChain: [
      { tool: "filings.search", purpose: "Recent 8-K filings", exampleArgs: { form: "8-K", limit: 100 } },
      { tool: "sections.get", purpose: "Item 5.02 text per match", exampleArgs: { ticker: "DIS", form: "8-K", sectionKey: "item_5_02" } },
      { tool: "comp.compare", purpose: "Comp comparison context", exampleArgs: { ticker: "DIS", limit: 10 } },
      { tool: "owners.get_13f", purpose: "Institutional ownership snapshot", exampleArgs: { cik: "0001744489" } },
    ],
    expectedOutput: "Governance-comms digest with appointee profiles + comp context per match.",
    difficulty: "intermediate",
  },
  {
    id: "pr-firm-segment-disclosure-narrative",
    persona: "pr-firm",
    status: "v1",
    title: "Build segment-disclosure narrative for IR roadshow prep",
    category: "Roadshow prep",
    oneLiner:
      "Walk segment footnotes + segment income for an IR roadshow narrative.",
    prompt:
      "For an IR client (diversified issuer), pull the segment-disclosure footnote from the latest 10-K, align with the latest annual segment-level income statement, and surface the segment with the largest absolute revenue growth and the segment with the largest margin compression. Output a roadshow narrative with three segment-level talking points.",
    expectedToolChain: [
      { tool: "intelligence.footnotes", purpose: "Segment-disclosure footnote", exampleArgs: { ticker: "AMZN", form: "10-K", topics: ["segment"] } },
      { tool: "companies.income_statements", purpose: "Segmented income statement", exampleArgs: { ticker: "AMZN", period: "annual", limit: 3 } },
      { tool: "sections.get", purpose: "Item 8 financial-statement narrative", exampleArgs: { ticker: "AMZN", form: "10-K", sectionKey: "item_8" } },
      { tool: "entities.resolve", purpose: "Resolve issuer", exampleArgs: { ticker: "AMZN" } },
    ],
    expectedOutput: "Roadshow narrative + 3 segment-level talking points.",
    difficulty: "intermediate",
  },
  {
    id: "pr-firm-stakeholder-sentiment-pulse",
    persona: "pr-firm",
    status: "v1",
    title: "Pulse stakeholder sentiment via factor cohort + 13F + intelligence",
    category: "Sentiment monitoring",
    oneLiner:
      "Triangulate stakeholder sentiment using factor peers + ownership rotation + intelligence query.",
    prompt:
      "For a corporate IR client, surface a sentiment pulse: build the factor-similar peer set, pull quarter-over-quarter institutional rotation across the cohort, and run a semantic intelligence query for analyst sentiment in the past 60 days. Output a 1-page stakeholder-sentiment briefing with three takeaways.",
    expectedToolChain: [
      { tool: "entities.resolve", purpose: "Resolve client", exampleArgs: { ticker: "DIS" } },
      { tool: "factors.related_stocks", purpose: "Factor-similar peer cohort", exampleArgs: { symbol: "DIS", limit: 10 } },
      { tool: "owners.compare_13f", purpose: "Cohort rotation signal", exampleArgs: { cik: "0001744489" } },
      { tool: "intelligence.query", purpose: "Analyst sentiment semantic signal", exampleArgs: { query: "analyst sentiment streaming media past 60 days", entities: ["DIS", "NFLX"] } },
    ],
    expectedOutput: "1-page stakeholder-sentiment briefing with 3 takeaways.",
    difficulty: "advanced",
  },

  // ----------------------------------------------------------------------------
  // SOPHISTICATED-INVESTOR (8 v1, 4 v2-pending)
  // ----------------------------------------------------------------------------
  {
    id: "sophisticated-investor-equity-comp-burn-rate",
    persona: "sophisticated-investor",
    status: "v1",
    title: "Equity comp burn-rate forensics",
    category: "Equity comp forensics",
    oneLiner:
      "Walk equity comp grants vs cash flow vs shares outstanding to surface dilution-via-comp risk.",
    prompt:
      "For a high-growth issuer with heavy equity-comp use (e.g., SNOW), pull the latest named-executive comp, the trailing 5 years of cash flow statements (focus on share-based compensation), the income statement (for share-based-comp expense line), and the relevant XBRL fact (ShareBasedCompensation tag). Compute equity-comp burn rate as a fraction of revenue and as shares-issued-as-comp / shares-outstanding. Output a forensic memo.",
    expectedToolChain: [
      { tool: "comp.list", purpose: "Named-executive comp baseline", exampleArgs: { ticker: "SNOW", limit: 10 } },
      { tool: "companies.cash_flow_statements", purpose: "5-year share-based comp cash flow line", exampleArgs: { ticker: "SNOW", period: "annual", limit: 5 } },
      { tool: "facts.get", purpose: "ShareBasedCompensation XBRL fact", exampleArgs: { ticker: "SNOW", tag: "ShareBasedCompensation", form: "10-K" } },
      { tool: "companies.income_statements", purpose: "Revenue context for burn rate", exampleArgs: { ticker: "SNOW", period: "annual", limit: 5 } },
    ],
    expectedOutput: "Forensic memo + burn-rate table (% revenue, % shares-out).",
    difficulty: "advanced",
  },
  {
    id: "sophisticated-investor-debt-covenant-headroom",
    persona: "sophisticated-investor",
    status: "v1",
    title: "Debt covenant headroom check",
    category: "Credit forensics",
    oneLiner:
      "Pull debt-covenant footnote + balance sheet to estimate covenant headroom.",
    prompt:
      "For a leveraged issuer (e.g., HTZ), pull the debt-covenant footnote (intelligence.footnotes topic=debt_covenant), the latest balance sheet (focus on debt + cash), and the latest ratios (leverage, interest coverage). Cross-reference with the MD&A (Item 7) for any covenant-relief or amendment language. Output a covenant headroom estimate (% of trigger) + 3-paragraph risk summary.",
    expectedToolChain: [
      { tool: "intelligence.footnotes", purpose: "Debt-covenant footnote text", exampleArgs: { ticker: "HTZ", form: "10-K", topics: ["debt_covenant"] } },
      { tool: "companies.balance_sheets", purpose: "Debt + cash snapshot", exampleArgs: { ticker: "HTZ", period: "quarterly", limit: 1 } },
      { tool: "companies.ratios", purpose: "Leverage + interest coverage", exampleArgs: { ticker: "HTZ", period: "quarterly", limit: 4 } },
      { tool: "sections.get", purpose: "MD&A covenant amendment language", exampleArgs: { ticker: "HTZ", form: "10-K", sectionKey: "item_7" } },
    ],
    expectedOutput: "Covenant headroom % + 3-paragraph risk summary.",
    difficulty: "advanced",
  },
  {
    id: "sophisticated-investor-tax-position-stress",
    persona: "sophisticated-investor",
    status: "v1",
    title: "Stress-test uncertain tax positions",
    category: "Tax forensics",
    oneLiner:
      "Surface uncertain tax positions and stress-test against income statement.",
    prompt:
      "For a multinational (e.g., GOOGL), pull the tax footnote (intelligence.footnotes topic=tax), the deferred-tax-asset XBRL fact, the trailing 3 years of income statement (focus on effective tax rate), and the relevant 10-K MD&A passages. Stress-test scenarios where deferred-tax assets are written down by 25/50/100%. Output a tax forensics memo + scenario impact table.",
    expectedToolChain: [
      { tool: "intelligence.footnotes", purpose: "Tax footnote text", exampleArgs: { ticker: "GOOGL", form: "10-K", topics: ["tax"] } },
      { tool: "facts.get", purpose: "DeferredTaxAssetsNet XBRL fact", exampleArgs: { ticker: "GOOGL", tag: "DeferredTaxAssetsNet", form: "10-K" } },
      { tool: "companies.income_statements", purpose: "Effective-tax-rate trajectory", exampleArgs: { ticker: "GOOGL", period: "annual", limit: 3 } },
      { tool: "sections.get", purpose: "MD&A tax discussion", exampleArgs: { ticker: "GOOGL", form: "10-K", sectionKey: "item_7" } },
    ],
    expectedOutput: "Tax forensics memo + 25/50/100% write-down scenario table.",
    difficulty: "advanced",
  },
  {
    id: "sophisticated-investor-revenue-recognition-forensics",
    persona: "sophisticated-investor",
    status: "v1",
    title: "Revenue-recognition forensics on growth narratives",
    category: "Revenue forensics",
    oneLiner:
      "Compare deferred revenue + revenue footnote + income statement for revenue-recognition aggression.",
    prompt:
      "For a high-growth SaaS issuer (e.g., NOW), pull the revenue-recognition footnote (intelligence.footnotes topic=revenue), the deferred-revenue XBRL fact across 5 years, the trailing 5-year income statement, and the MD&A passages. Surface any divergence between billings growth, deferred revenue, and recognized revenue. Output a forensic memo with a billings-vs-revenue ratio table.",
    expectedToolChain: [
      { tool: "intelligence.footnotes", purpose: "Revenue-recognition footnote text", exampleArgs: { ticker: "NOW", form: "10-K", topics: ["revenue"] } },
      { tool: "facts.get", purpose: "DeferredRevenue XBRL fact 5-year", exampleArgs: { ticker: "NOW", tag: "DeferredRevenueCurrent", form: "10-K" } },
      { tool: "companies.income_statements", purpose: "5-year revenue trajectory", exampleArgs: { ticker: "NOW", period: "annual", limit: 5 } },
      { tool: "sections.get", purpose: "MD&A revenue discussion", exampleArgs: { ticker: "NOW", form: "10-K", sectionKey: "item_7" } },
    ],
    expectedOutput: "Revenue forensic memo + billings-vs-revenue ratio table.",
    difficulty: "advanced",
  },
  {
    id: "sophisticated-investor-13f-divergence-thesis",
    persona: "sophisticated-investor",
    status: "v1",
    title: "Spot smart-money divergence for thesis validation",
    category: "Smart-money signals",
    oneLiner:
      "Surface 13F filers diverging on a name and cross-reference with insider trades + comp.",
    prompt:
      "For a contested name (e.g., GME), pull the latest 13F snapshot for the top 20 institutional holders, compare quarter-over-quarter, identify the 5 holders making the largest position increases AND the 5 making the largest decreases, then pull insider Form 4 history and comp comparison. Output a divergence memo for short/long thesis validation.",
    expectedToolChain: [
      { tool: "owners.get_13f", purpose: "Top-20 institutional snapshot", exampleArgs: { cik: "0001326380" } },
      { tool: "owners.compare_13f", purpose: "Q-over-Q rotation", exampleArgs: { cik: "0001326380" } },
      { tool: "insiders.list", purpose: "Insider Form 4 history", exampleArgs: { ticker: "GME", limit: 50 } },
      { tool: "comp.compare", purpose: "Comp comparison for executive alignment", exampleArgs: { ticker: "GME", limit: 10 } },
    ],
    expectedOutput: "Divergence memo + long/short thesis validation table.",
    difficulty: "advanced",
  },
  {
    id: "sophisticated-investor-going-concern-sweep",
    persona: "sophisticated-investor",
    status: "v1",
    title: "Sweep small-cap watchlist for going-concern language",
    category: "Solvency forensics",
    oneLiner:
      "Find substantial-doubt and going-concern language across small caps and estimate runway.",
    prompt:
      "For a watchlist of 100 US micro-caps, search 10-K and 10-Q filings for 'going concern' or 'substantial doubt' language. For each match, pull Item 9A (Controls), the latest balance sheet, and the cash flow statement to estimate runway. Output a runway-ranked alert table with one-line risk summary per name.",
    expectedToolChain: [
      { tool: "sections.search", purpose: "Going-concern keyword sweep", exampleArgs: { q: "going concern substantial doubt", form: "10-K", limit: 50 } },
      { tool: "sections.get", purpose: "Item 9A internal-controls text", exampleArgs: { ticker: "MULN", form: "10-K", sectionKey: "item_9a" } },
      { tool: "companies.balance_sheets", purpose: "Latest balance sheet for runway", exampleArgs: { ticker: "MULN", period: "quarterly", limit: 1 } },
      { tool: "companies.cash_flow_statements", purpose: "Burn-rate context", exampleArgs: { ticker: "MULN", period: "quarterly", limit: 4 } },
    ],
    expectedOutput: "Runway-ranked alert table + 1-line risk summary per name.",
    difficulty: "intermediate",
  },
  {
    id: "sophisticated-investor-lease-obligations-forensics",
    persona: "sophisticated-investor",
    status: "v1",
    title: "Lease-obligation off-balance-sheet forensics",
    category: "Off-balance-sheet",
    oneLiner:
      "Walk lease footnote + balance sheet + XBRL lease tags to estimate true leverage.",
    prompt:
      "For a lease-heavy retailer (e.g., M), pull the lease footnote (intelligence.footnotes topic=lease), the operating-lease-liability XBRL fact, the latest balance sheet, and the cash flow statement. Compute adjusted leverage including capitalized operating leases at 8x rent. Output a lease-adjusted leverage memo + comparison table vs reported leverage.",
    expectedToolChain: [
      { tool: "intelligence.footnotes", purpose: "Lease footnote text", exampleArgs: { ticker: "M", form: "10-K", topics: ["lease"] } },
      { tool: "facts.get", purpose: "OperatingLeaseLiability XBRL fact", exampleArgs: { ticker: "M", tag: "OperatingLeaseLiabilityCurrent", form: "10-K" } },
      { tool: "companies.balance_sheets", purpose: "Reported balance sheet", exampleArgs: { ticker: "M", period: "annual", limit: 3 } },
      { tool: "companies.cash_flow_statements", purpose: "Lease cash flows", exampleArgs: { ticker: "M", period: "annual", limit: 3 } },
    ],
    expectedOutput: "Lease-adjusted leverage memo + reported-vs-adjusted comparison table.",
    difficulty: "advanced",
  },
  {
    id: "sophisticated-investor-segment-aggregation-forensics",
    persona: "sophisticated-investor",
    status: "v1",
    title: "Segment-disclosure forensics on diversified issuers",
    category: "Segment forensics",
    oneLiner:
      "Surface segment-aggregation choices and compare to peer disclosure granularity.",
    prompt:
      "For a diversified issuer (e.g., GE), pull the segment-disclosure footnote and segment income statement. Compare segment count and revenue concentration to factor-similar peers. Identify any segment that contributes more than 50% of revenue but less than 30% of segment-level disclosure. Output a segment-aggregation forensic memo.",
    expectedToolChain: [
      { tool: "intelligence.footnotes", purpose: "Segment-disclosure footnote", exampleArgs: { ticker: "GE", form: "10-K", topics: ["segment"] } },
      { tool: "companies.income_statements", purpose: "Segmented income", exampleArgs: { ticker: "GE", period: "annual", limit: 3 } },
      { tool: "sections.get", purpose: "Item 8 financial-statement segment narrative", exampleArgs: { ticker: "GE", form: "10-K", sectionKey: "item_8" } },
      { tool: "factors.related_stocks", purpose: "Peer-set comparison", exampleArgs: { symbol: "GE", limit: 5 } },
    ],
    expectedOutput: "Segment-aggregation forensic memo + peer disclosure granularity comparison.",
    difficulty: "advanced",
  },
  // v2-pending
  {
    id: "sophisticated-investor-warrants-overhang",
    persona: "sophisticated-investor",
    status: "v2-pending",
    title: "Surface warrant + convertible overhang for dilution thesis",
    category: "Dilution forensics (v2)",
    oneLiner:
      "Walk warrants, convertibles, and shares outstanding to estimate dilution overhang.",
    prompt:
      "For a low-float small cap with active capital raises, pull the dilution.warrants_query for outstanding warrants, dilution.convertibles for convertible debt, dilution.cash_position for runway, and cross-reference with the latest balance sheet + named-executive comp. Compute share-overhang at exercise and probability-weighted dilution at 12m horizon.",
    expectedToolChain: [
      { tool: "dilution.warrants_query", purpose: "Outstanding warrant inventory (FUTURE)", exampleArgs: { ticker: "MULN" } },
      { tool: "dilution.convertibles", purpose: "Convertible debt inventory (FUTURE)", exampleArgs: { ticker: "MULN" } },
      { tool: "dilution.cash_position", purpose: "Runway + burn (FUTURE)", exampleArgs: { ticker: "MULN" } },
      { tool: "companies.balance_sheets", purpose: "Reported balance sheet", exampleArgs: { ticker: "MULN", period: "quarterly", limit: 1 } },
    ],
    expectedOutput: "Dilution-overhang memo + 12m probability-weighted share-count scenario table.",
    blockedBy: ["OMNI-3071", "OMNI-3079", "OMNI-3087"],
    difficulty: "advanced",
  },
  {
    id: "sophisticated-investor-atm-program-tracking",
    persona: "sophisticated-investor",
    status: "v2-pending",
    title: "Track ATM program activity for dilution-velocity signal",
    category: "Dilution forensics (v2)",
    oneLiner:
      "Detect ATM program issuance velocity and cross-reference with insider trading.",
    prompt:
      "For an issuer with an active ATM (at-the-market) program, pull dilution.events for the latest ATM issuance, dilution.cash_position for runway impact, owners.compare_13f for institutional response, and insiders.list for any insider trading around the ATM dates. Output a dilution-velocity dashboard.",
    expectedToolChain: [
      { tool: "dilution.events", purpose: "ATM issuance events (FUTURE)", exampleArgs: { ticker: "MULN" } },
      { tool: "dilution.cash_position", purpose: "Runway impact (FUTURE)", exampleArgs: { ticker: "MULN" } },
      { tool: "owners.compare_13f", purpose: "Institutional response", exampleArgs: { cik: "0001770787" } },
      { tool: "insiders.list", purpose: "Insider trades around ATM dates", exampleArgs: { ticker: "MULN", limit: 20 } },
    ],
    expectedOutput: "Dilution-velocity dashboard.",
    blockedBy: ["OMNI-3071", "OMNI-3079", "OMNI-3087"],
    difficulty: "advanced",
  },
  {
    id: "sophisticated-investor-convertible-overhang-stress",
    persona: "sophisticated-investor",
    status: "v2-pending",
    title: "Stress-test convertible overhang against share price scenarios",
    category: "Dilution forensics (v2)",
    oneLiner:
      "Walk convertible inventory + price-based conversion mechanics for dilution risk.",
    prompt:
      "For an issuer with toxic convertibles, pull dilution.convertibles for the inventory + conversion mechanics (variable-reset, full-ratchet), dilution.warrants_query for any associated warrants, and stress-test share-count at -25%/-50% price scenarios. Cross-reference with companies.balance_sheets for cash + debt.",
    expectedToolChain: [
      { tool: "dilution.convertibles", purpose: "Convertible inventory + mechanics (FUTURE)", exampleArgs: { ticker: "MULN" } },
      { tool: "dilution.warrants_query", purpose: "Associated warrant inventory (FUTURE)", exampleArgs: { ticker: "MULN" } },
      { tool: "dilution.cash_position", purpose: "Cash + runway (FUTURE)", exampleArgs: { ticker: "MULN" } },
      { tool: "companies.balance_sheets", purpose: "Reported balance sheet", exampleArgs: { ticker: "MULN", period: "quarterly", limit: 1 } },
    ],
    expectedOutput: "Convertible stress-test memo + scenario share-count table.",
    blockedBy: ["OMNI-3071", "OMNI-3079", "OMNI-3087"],
    difficulty: "advanced",
  },
  {
    id: "sophisticated-investor-cash-runway-forensics",
    persona: "sophisticated-investor",
    status: "v2-pending",
    title: "Cash runway forensics with corporate-action overlay",
    category: "Dilution forensics (v2)",
    oneLiner:
      "Compute cash runway and overlay reverse-split/de-SPAC corporate-action history.",
    prompt:
      "For a small-cap with cash burn concerns, pull dilution.cash_position for runway, dilution.corporate_actions for any reverse splits or de-SPACs in the past 24 months, dilution.ratings for the composite risk score, and cross-reference with companies.cash_flow_statements. Output a runway forensics memo.",
    expectedToolChain: [
      { tool: "dilution.cash_position", purpose: "Cash + burn + runway (FUTURE)", exampleArgs: { ticker: "MULN" } },
      { tool: "dilution.corporate_actions", purpose: "Reverse-split / de-SPAC history (FUTURE)", exampleArgs: { ticker: "MULN" } },
      { tool: "dilution.ratings", purpose: "Composite dilution risk score (FUTURE)", exampleArgs: { ticker: "MULN" } },
      { tool: "companies.cash_flow_statements", purpose: "Burn-rate context", exampleArgs: { ticker: "MULN", period: "quarterly", limit: 4 } },
    ],
    expectedOutput: "Cash runway forensics memo with corporate-action overlay.",
    blockedBy: ["OMNI-3071", "OMNI-3079", "OMNI-3087"],
    difficulty: "advanced",
  },

  // ----------------------------------------------------------------------------
  // INSURANCE (6 v1, 6 v2-pending)
  // ----------------------------------------------------------------------------
  {
    id: "insurance-d-and-o-underwriting-profile",
    persona: "insurance",
    status: "v1",
    title: "Build a D&O underwriting profile for a renewal candidate",
    category: "D&O underwriting",
    oneLiner:
      "Compile board comp, ownership concentration, and insider activity for D&O risk pricing.",
    prompt:
      "You are a risk assessment agent with access to SEC API. For any company under review, check enforcement history, pull the company intelligence bundle for financial health, review executive compensation structures, and extract auditor opinion and risk-factor sections from the latest 10-K. Flag restatements, auditor changes, and enforcement actions as high-priority findings. Always include requestId references for compliance documentation.",
    expectedToolChain: [
      { tool: "comp.list", purpose: "Named-executive comp baseline", exampleArgs: { ticker: "WFC", limit: 10 } },
      { tool: "owners.get_13f", purpose: "Ownership-concentration snapshot", exampleArgs: { cik: "0000072971" } },
      { tool: "insiders.list", purpose: "Officer/director Form 4 history", exampleArgs: { ticker: "WFC", limit: 50 } },
      { tool: "comp.compare", purpose: "Year-over-year comp comparison", exampleArgs: { ticker: "WFC", limit: 10 } },
    ],
    expectedOutput: "D&O underwriting memo + scorecard + requestId citations.",
    caveats: [
      "AAER (Accounting and Auditing Enforcement Releases) enrichment is keyword-search only in v1; typed AAER ships with the v2 backfill.",
    ],
    difficulty: "intermediate",
  },
  {
    id: "insurance-auditor-change-keyword-scan",
    persona: "insurance",
    status: "v1",
    title: "Scan watchlist for auditor changes via Item 4.01 keyword search",
    category: "Auditor monitoring",
    oneLiner:
      "Detect auditor changes by keyword-searching 8-K Item 4.01 disclosures.",
    prompt:
      "For a watchlist of 50 insureds, search the past 90 days of 8-K filings for any 'Item 4.01' or 'Changes in Registrant's Certifying Accountant' language. For each match, extract the Item 4.01 text, identify the predecessor and successor auditor, and run a semantic intelligence query for any related material-weakness disclosures. Output a watchlist alert ranked by claim-trigger likelihood.",
    expectedToolChain: [
      { tool: "sections.search", purpose: "Item 4.01 keyword search", exampleArgs: { form: "8-K", q: "Item 4.01 auditor change Changes in Registrant Certifying Accountant", limit: 50 } },
      { tool: "sections.get", purpose: "Item 4.01 text per match", exampleArgs: { ticker: "WFC", form: "8-K", sectionKey: "item_4_01" } },
      { tool: "filings.search", purpose: "Recent 8-K filings", exampleArgs: { form: "8-K", limit: 100 } },
      { tool: "intelligence.query", purpose: "Material-weakness corroboration", exampleArgs: { query: "material weakness internal controls auditor change", entities: ["WFC"] } },
    ],
    expectedOutput: "Watchlist alert table ranked by claim-trigger likelihood.",
    caveats: [
      "Keyword-search-based; typed auditor-change events ship with v2 backfill (typed audit-change MCP wrap).",
    ],
    difficulty: "intermediate",
  },
  {
    id: "insurance-material-weakness-semantic-scan",
    persona: "insurance",
    status: "v1",
    title: "Semantic scan for material-weakness disclosures",
    category: "Internal-control risk",
    oneLiner:
      "Use semantic intelligence query to find material-weakness language across recent filings.",
    prompt:
      "For a renewal book of insureds, run a semantic intelligence query for 'material weakness internal control' language in the past 12 months of 10-K filings. For each match, search for related sections, extract Item 9A (Controls and Procedures), and pull the latest 10-K/A filings (amended annual reports). Output a material-weakness watchlist with severity ranking.",
    expectedToolChain: [
      { tool: "intelligence.query", purpose: "Semantic material-weakness signal", exampleArgs: { query: "material weakness internal control over financial reporting", lookback: 365 } },
      { tool: "sections.search", purpose: "Find Item 9A disclosures", exampleArgs: { q: "material weakness", form: "10-K", limit: 50 } },
      { tool: "sections.get", purpose: "Item 9A text per match", exampleArgs: { ticker: "WFC", form: "10-K", sectionKey: "item_9a" } },
      { tool: "filings.search", purpose: "10-K/A inventory", exampleArgs: { form: "10-K/A", limit: 20 } },
    ],
    expectedOutput: "Material-weakness watchlist with severity ranking.",
    difficulty: "intermediate",
  },
  {
    id: "insurance-restatement-detection-renewal-book",
    persona: "insurance",
    status: "v1",
    title: "Detect restatements across renewal book",
    category: "Restatement risk",
    oneLiner:
      "Sweep renewal book for 10-K/A restatement filings + supporting context.",
    prompt:
      "For a renewal book of 100 insureds, sweep for any 10-K/A (amended annual report) filed in the past 24 months. For each match, search for 'restatement' language in the underlying 10-K, pull Item 9A (Controls), and run an intelligence query for any analyst commentary in the same window. Output a restatement-risk ranked alert table for the renewal pricing committee.",
    expectedToolChain: [
      { tool: "filings.search", purpose: "10-K/A inventory", exampleArgs: { form: "10-K/A", limit: 50 } },
      { tool: "sections.search", purpose: "Restatement language search", exampleArgs: { q: "restatement", form: "10-K/A", limit: 50 } },
      { tool: "intelligence.query", purpose: "Analyst commentary signal", exampleArgs: { query: "restatement analyst response severity", lookback: 90 } },
      { tool: "sections.get", purpose: "Item 9A text per match", exampleArgs: { ticker: "WFC", form: "10-K", sectionKey: "item_9a" } },
    ],
    expectedOutput: "Restatement-risk ranked alert table for renewal pricing.",
    difficulty: "intermediate",
  },
  {
    id: "insurance-officer-departure-claims-trigger",
    persona: "insurance",
    status: "v1",
    title: "Track officer departures as potential claims triggers",
    category: "Claims monitoring",
    oneLiner:
      "Surface 8-K Item 5.02 officer departures for D&O claims-trigger alerts.",
    prompt:
      "For an insured book of 100 public companies, sweep the past 30 days of 8-K filings for any Item 5.02 (officer/director departure) disclosure. For each match, extract the Item 5.02 text, pull the executive's most recent comp comparison, and check Form 4 trading activity in the past 60 days. Output a claims-trigger alert digest.",
    expectedToolChain: [
      { tool: "filings.search", purpose: "Recent 8-K filings", exampleArgs: { form: "8-K", limit: 100 } },
      { tool: "sections.get", purpose: "Item 5.02 text per match", exampleArgs: { ticker: "WFC", form: "8-K", sectionKey: "item_5_02" } },
      { tool: "comp.compare", purpose: "Departing officer's comp history", exampleArgs: { ticker: "WFC", limit: 10 } },
      { tool: "insiders.list", purpose: "Recent Form 4 trades", exampleArgs: { ticker: "WFC", limit: 30 } },
    ],
    expectedOutput: "Claims-trigger alert digest with departure profile per match.",
    difficulty: "intermediate",
  },
  {
    id: "insurance-peer-benchmark-renewal-pricing",
    persona: "insurance",
    status: "v1",
    title: "Peer-benchmark for renewal pricing context",
    category: "Pricing benchmarking",
    oneLiner:
      "Build a factor-similar peer set for renewal pricing context.",
    prompt:
      "For an insured renewal candidate, generate the top 10 factor-similar peer companies, pull each peer's most recent annual financials and named-executive comp, and run an intelligence query for any peer-specific risk events in the past 12 months. Output a renewal pricing context table.",
    expectedToolChain: [
      { tool: "factors.related_stocks", purpose: "Factor-similar peer cohort", exampleArgs: { symbol: "WFC", limit: 10 } },
      { tool: "companies.financials", purpose: "Peer fundamentals", exampleArgs: { ticker: "JPM", period: "annual", limit: 1 } },
      { tool: "comp.list", purpose: "Peer named-executive comp", exampleArgs: { ticker: "JPM", limit: 5 } },
      { tool: "intelligence.query", purpose: "Peer-specific risk events", exampleArgs: { query: "regulatory risk events past 12 months", entities: ["JPM"] } },
    ],
    expectedOutput: "Renewal pricing context table.",
    difficulty: "intermediate",
  },
  // v2-pending
  {
    id: "insurance-aaer-enrichment-respondent-profile",
    persona: "insurance",
    status: "v2-pending",
    title: "Enrich AAER respondent profile for D&O claims investigation",
    category: "AAER enrichment (v2)",
    oneLiner:
      "Pull typed AAER metadata + respondent comp + ownership for claims investigation.",
    prompt:
      "For an AAER respondent (Accounting and Auditing Enforcement Release), pull events.enforcement for the typed AAER record, comp.list for the respondent's comp history, owners.get_13f for institutional context, and insiders.list for trading activity in the AAER window. Output an enriched respondent profile.",
    expectedToolChain: [
      { tool: "events.enforcement", purpose: "Typed AAER metadata (FUTURE)", exampleArgs: { ticker: "WFC" } },
      { tool: "comp.list", purpose: "Respondent comp history", exampleArgs: { ticker: "WFC", limit: 10 } },
      { tool: "owners.get_13f", purpose: "Institutional context", exampleArgs: { cik: "0000072971" } },
      { tool: "insiders.list", purpose: "Trading activity in AAER window", exampleArgs: { ticker: "WFC", limit: 30 } },
    ],
    expectedOutput: "Enriched AAER respondent profile.",
    blockedBy: ["AAER-MCP-WRAP"],
    difficulty: "advanced",
  },
  {
    id: "insurance-aaer-timeline-enforcement",
    persona: "insurance",
    status: "v2-pending",
    title: "Build an AAER enforcement timeline for an issuer",
    category: "AAER enrichment (v2)",
    oneLiner:
      "Walk all AAERs for an issuer and build a typed enforcement timeline.",
    prompt:
      "For an issuer with multiple AAER findings, pull events.enforcement to enumerate all AAERs in the past 5 years, cross-reference with filings.search for any related 8-K disclosures, and pull the latest 10-K Item 9A. Output a typed enforcement timeline + AAER-to-disclosure mapping.",
    expectedToolChain: [
      { tool: "events.enforcement", purpose: "AAER enumeration (FUTURE)", exampleArgs: { ticker: "WFC", limit: 20 } },
      { tool: "filings.search", purpose: "Related 8-K disclosures", exampleArgs: { ticker: "WFC", form: "8-K", limit: 50 } },
      { tool: "sections.get", purpose: "Item 9A internal-controls text", exampleArgs: { ticker: "WFC", form: "10-K", sectionKey: "item_9a" } },
      { tool: "intelligence.query", purpose: "Cross-period analyst commentary", exampleArgs: { query: "enforcement timeline analyst commentary", entities: ["WFC"] } },
    ],
    expectedOutput: "Typed AAER enforcement timeline + AAER-to-disclosure mapping.",
    blockedBy: ["AAER-MCP-WRAP"],
    difficulty: "advanced",
  },
  {
    id: "insurance-aaer-enforcement-match",
    persona: "insurance",
    status: "v2-pending",
    title: "Match an insured's filings to historical AAER fact patterns",
    category: "AAER enrichment (v2)",
    oneLiner:
      "Compare insured's disclosure language to historical AAER cases for risk scoring.",
    prompt:
      "For an insured, pull the latest 10-K, run intelligence.query against the AAER corpus to find the 5 most similar historical AAER cases via events.enforcement, and produce an AAER-similarity risk score. Cross-reference with comp.list for executive context.",
    expectedToolChain: [
      { tool: "intelligence.query", purpose: "Semantic AAER similarity", exampleArgs: { query: "AAER fact pattern match", entities: ["WFC"] } },
      { tool: "events.enforcement", purpose: "Historical AAER cases (FUTURE)", exampleArgs: { limit: 5 } },
      { tool: "sections.get", purpose: "Insured's latest 10-K Item 9A", exampleArgs: { ticker: "WFC", form: "10-K", sectionKey: "item_9a" } },
      { tool: "comp.list", purpose: "Executive context", exampleArgs: { ticker: "WFC", limit: 10 } },
    ],
    expectedOutput: "AAER-similarity risk score + 5 most-similar historical cases.",
    blockedBy: ["AAER-MCP-WRAP"],
    difficulty: "advanced",
  },
  {
    id: "insurance-typed-auditor-change-event",
    persona: "insurance",
    status: "v2-pending",
    title: "Use typed auditor-change events for renewal monitoring",
    category: "Auditor monitoring (v2)",
    oneLiner:
      "Replace keyword search with a typed auditor-change MCP event stream.",
    prompt:
      "For a renewal book, pull events.auditor_changes for typed auditor-change events in the past 90 days. For each event, fetch the predecessor and successor auditor, the related 8-K filing, and any 10-K/A amendments. Output a typed auditor-change watchlist.",
    expectedToolChain: [
      { tool: "events.auditor_changes", purpose: "Typed auditor-change stream (FUTURE)", exampleArgs: { limit: 50 } },
      { tool: "filings.search", purpose: "Related 8-K filings", exampleArgs: { form: "8-K", limit: 50 } },
      { tool: "sections.get", purpose: "Item 4.01 corroboration", exampleArgs: { ticker: "WFC", form: "8-K", sectionKey: "item_4_01" } },
      { tool: "filings.search", purpose: "Related 10-K/A inventory", exampleArgs: { form: "10-K/A", limit: 20 } },
    ],
    expectedOutput: "Typed auditor-change watchlist.",
    blockedBy: ["TYPED-AUDIT-CHANGE-MCP"],
    difficulty: "intermediate",
  },
  {
    id: "insurance-form-144-monitoring",
    persona: "insurance",
    status: "v2-pending",
    title: "Monitor Form 144 affiliate-sale notices",
    category: "Form 144 monitoring (v2)",
    oneLiner:
      "Track Form 144 (Notice of Proposed Sale of Securities) filings across renewal book.",
    prompt:
      "For a renewal book, pull forms.144 for the past 30 days of Form 144 affiliate-sale notices. For each notice, identify the filer, the planned sale size, and cross-reference with insiders.list for actual transactions. Output a Form 144 watchlist with planned-vs-actual sale tracking.",
    expectedToolChain: [
      { tool: "forms.144", purpose: "Form 144 affiliate-sale notices (FUTURE)", exampleArgs: { limit: 50 } },
      { tool: "insiders.list", purpose: "Actual Form 4 transactions", exampleArgs: { ticker: "WFC", limit: 30 } },
      { tool: "comp.list", purpose: "Filer comp context", exampleArgs: { ticker: "WFC", limit: 10 } },
      { tool: "entities.resolve", purpose: "Resolve filer identifier", exampleArgs: { ticker: "WFC" } },
    ],
    expectedOutput: "Form 144 watchlist with planned-vs-actual sale tracking.",
    blockedBy: ["OMNI-3084"],
    difficulty: "intermediate",
  },
  {
    id: "insurance-subsidiaries-discovery",
    persona: "insurance",
    status: "v2-pending",
    title: "Map insured's subsidiaries for coverage scope",
    category: "Subsidiaries discovery (v2)",
    oneLiner:
      "Pull subsidiaries graph for an insured to scope D&O coverage correctly.",
    prompt:
      "For an insured, pull companies.subsidiaries for the full subsidiaries graph, cross-reference with filings.search for any subsidiary-level filings, and pull comp comparison context for the parent. Output a subsidiaries map + coverage-scope recommendation.",
    expectedToolChain: [
      { tool: "companies.subsidiaries", purpose: "Subsidiaries graph (FUTURE)", exampleArgs: { ticker: "WFC" } },
      { tool: "filings.search", purpose: "Subsidiary-level filings", exampleArgs: { ticker: "WFC", limit: 20 } },
      { tool: "entities.resolve", purpose: "Resolve subsidiary entities", exampleArgs: { ticker: "WFC" } },
      { tool: "comp.compare", purpose: "Parent comp comparison context", exampleArgs: { ticker: "WFC", limit: 10 } },
    ],
    expectedOutput: "Subsidiaries map + coverage-scope recommendation.",
    blockedBy: ["OMNI-3084"],
    difficulty: "intermediate",
  },
] as const

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

export function listPromptsByPersona(
  persona: AgentPromptPersona,
  opts?: { includeV2Pending?: boolean },
): AgentPrompt[] {
  const includeV2 = opts?.includeV2Pending ?? false
  return AGENT_PROMPT_LIBRARY.filter((entry) => {
    if (entry.persona !== persona) return false
    if (!includeV2 && entry.status === "v2-pending") return false
    return true
  })
}

export function getPrompt(id: string): AgentPrompt | undefined {
  return AGENT_PROMPT_LIBRARY.find((entry) => entry.id === id)
}

export function v1Count(): number {
  return AGENT_PROMPT_LIBRARY.filter((entry) => entry.status === "v1").length
}

export function v2PendingCount(): number {
  return AGENT_PROMPT_LIBRARY.filter((entry) => entry.status === "v2-pending").length
}

export function v1CountByPersona(): Record<AgentPromptPersona, number> {
  const out = Object.fromEntries(
    AGENT_PROMPT_PERSONAS.map((slug) => [slug, 0]),
  ) as Record<AgentPromptPersona, number>
  for (const entry of AGENT_PROMPT_LIBRARY) {
    if (entry.status === "v1") out[entry.persona] += 1
  }
  return out
}

export function v2PendingCountByPersona(): Record<AgentPromptPersona, number> {
  const out = Object.fromEntries(
    AGENT_PROMPT_PERSONAS.map((slug) => [slug, 0]),
  ) as Record<AgentPromptPersona, number>
  for (const entry of AGENT_PROMPT_LIBRARY) {
    if (entry.status === "v2-pending") out[entry.persona] += 1
  }
  return out
}

/**
 * Per-persona v1 distribution committed by OMNI-3085 plan (D2).
 * The structural validator asserts `v1CountByPersona()` matches this exactly.
 */
export const EXPECTED_V1_DISTRIBUTION: Record<AgentPromptPersona, number> = {
  "investment-manager": 12,
  "law-firm": 12,
  "pr-firm": 12,
  "sophisticated-investor": 8,
  insurance: 6,
}
