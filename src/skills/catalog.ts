// Skill shortcuts — the 9 @secapi/skills workflows as guided `secapi` recipes.
//
// Each shortcut expands into an ordered list of real `secapi` commands (a
// "run-view" the REPL renders, DeepSearch-style). `{ticker}` / `{country}` /
// `{holdings}` placeholders are filled from the shortcut's argument. A workflow
// is `metered` if any step hits an ai_queries endpoint (intelligence.query).
// Pure + unit-testable; mirrors packages/skills/skills/*/metadata.json.

export type SkillArg = "ticker" | "country" | "holdings" | "none"

export interface SkillStep {
  label: string
  /** A `secapi` command template with {ticker}/{country}/{holdings} placeholders. */
  command: string
  metered?: boolean
}

export interface SkillShortcut {
  /** Slash name, e.g. "due-diligence" → /due-diligence. */
  slash: string
  title: string
  summary: string
  arg: SkillArg
  /** Mirrors the skill dir under packages/skills/skills. */
  skill: string
  steps: SkillStep[]
}

export const SKILL_SHORTCUTS: SkillShortcut[] = [
  {
    slash: "due-diligence",
    title: "Company due diligence",
    summary: "Entity context, filings, financials, factor exposures, insider activity, dilution, and a cited AI synthesis.",
    arg: "ticker",
    skill: "company-due-diligence",
    steps: [
      { label: "Resolve entity", command: "entities resolve --ticker {ticker}" },
      { label: "Company filings", command: "filings latest --ticker {ticker} --limit 5" },
      { label: "Financials", command: "companies financials --ticker {ticker}" },
      { label: "Factor exposures", command: "factors exposures --symbols {ticker} --view agent" },
      { label: "Insider activity", command: "insiders list --ticker {ticker}" },
      { label: "Dilution score", command: "dilution score --ticker {ticker} --view agent" },
      { label: "Synthesize (AI)", command: "intelligence company --ticker {ticker} --view compact", metered: true },
    ],
  },
  {
    slash: "analyze",
    title: "Analyze a company in context",
    summary: "Security + earnings preview + factor exposures against the current macro regime.",
    arg: "ticker",
    skill: "analyze-company-in-context",
    steps: [
      { label: "Security intelligence", command: "intelligence security --ticker {ticker} --view compact", metered: true },
      { label: "Earnings preview", command: "intelligence earnings-preview --ticker {ticker} --view compact", metered: true },
      { label: "Factor exposures", command: "factors exposures --symbols {ticker} --view agent" },
      { label: "Macro regime", command: "macro regimes --response-mode compact" },
    ],
  },
  {
    slash: "track-insiders",
    title: "Track insider activity",
    summary: "Form 3/4/5 insider transactions with company filing and entity context.",
    arg: "ticker",
    skill: "track-insiders-and-13fs",
    steps: [
      { label: "Insider transactions", command: "insiders list --ticker {ticker}" },
      { label: "Recent 8-K context", command: "filings latest --ticker {ticker} --form 8-K" },
      { label: "Entity context", command: "entities resolve --ticker {ticker}" },
    ],
  },
  {
    slash: "factor-dashboard",
    title: "Live factor dashboard",
    summary: "Intraday factor returns, loadings, and correlations.",
    arg: "none",
    skill: "use-live-factor-dashboard",
    steps: [
      { label: "Factor dashboard", command: "factors dashboard --response-mode compact --include trust" },
      { label: "Intraday returns", command: "factors returns-intraday --response-mode compact" },
      { label: "Correlations", command: "factors correlations --response-mode compact" },
    ],
  },
  {
    slash: "decompose",
    title: "Decompose return & hedge",
    summary: "Factor decomposition + stock loadings, with a security explainer.",
    arg: "ticker",
    skill: "decompose-return-and-hedge",
    steps: [
      { label: "Factor decomposition", command: "factors decomposition --ticker {ticker}" },
      { label: "Stock loadings", command: "stocks loadings --ticker {ticker}" },
      { label: "Explain (AI)", command: "intelligence security --ticker {ticker} --view compact", metered: true },
    ],
  },
  {
    slash: "footnotes",
    title: "Investigate filing footnotes",
    summary: "AI footnote query across a company's filings.",
    arg: "ticker",
    skill: "investigate-filing-footnotes",
    steps: [
      { label: "Footnotes query (AI)", command: 'intelligence footnotes-query --ticker {ticker} --q "leases"', metered: true },
      { label: "Company context", command: "intelligence company --ticker {ticker} --view compact", metered: true },
    ],
  },
  {
    slash: "factor-neutral",
    title: "Make a portfolio factor-neutral",
    summary: "Analyze → optimize → stress-test a holdings file toward factor neutrality.",
    arg: "holdings",
    skill: "make-portfolio-factor-neutral",
    steps: [
      { label: "Analyze", command: "portfolio analyze --holdings-file {holdings} --response-mode compact" },
      { label: "Optimize (factor-neutral)", command: "portfolio optimize --holdings-file {holdings} --objective factor_neutral" },
      { label: "Stress test", command: "portfolio stress-test --holdings-file {holdings}" },
    ],
  },
  {
    slash: "regime-screen",
    title: "Regime-aware screen",
    summary: "Regime screen + factor rotation against the current macro regime.",
    arg: "none",
    skill: "run-regime-aware-screen",
    steps: [
      { label: "Macro regimes", command: "macro regimes --response-mode compact" },
      { label: "Regime screen", command: "strategies regime-screen --response-mode compact" },
      { label: "Factor rotation", command: "strategies factor-rotation --response-mode compact" },
    ],
  },
  {
    slash: "country-report",
    title: "Country regime report",
    summary: "High-signal macro pack, regimes, and scheduled release context.",
    arg: "country",
    skill: "write-country-regime-report",
    steps: [
      { label: "High-signal pack", command: "macro high-signal-pack --country {country}" },
      { label: "Regimes", command: "macro regimes --country {country} --response-mode compact" },
      { label: "Scheduled releases", command: "macro releases --country {country} --status scheduled --days 45 --response-mode compact" },
    ],
  },
]

export function findSkillShortcut(slash: string): SkillShortcut | undefined {
  return SKILL_SHORTCUTS.find((s) => s.slash === slash)
}

export function skillIsMetered(shortcut: SkillShortcut): boolean {
  return shortcut.steps.some((step) => step.metered === true)
}

/** Fill {ticker}/{country}/{holdings} placeholders in a step command. */
export function fillStepCommand(command: string, arg: string): string {
  const safe = arg.trim()
  return command.replace(/\{ticker\}/g, safe).replace(/\{country\}/g, safe).replace(/\{holdings\}/g, safe)
}

/** The ordered, arg-filled command list for a shortcut (the run-view recipe). */
export function expandSkill(shortcut: SkillShortcut, arg: string): Array<{ label: string; command: string; metered: boolean }> {
  return shortcut.steps.map((step) => ({
    label: step.label,
    command: `secapi ${fillStepCommand(step.command, arg)}`,
    metered: step.metered === true,
  }))
}
