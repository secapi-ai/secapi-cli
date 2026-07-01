// Build the single-file CLI bundle.
//
// We bundle everything (workspace packages + Ink/React for the interactive TUI)
// into one `dist/index.js` so the published package keeps ZERO runtime
// dependencies and installs instantly. The interactive code is reached only via
// a dynamic import on the no-arg-TTY branch, so one-shot/piped/CI startup never
// pays React/Ink's cost.
//
// Ink optionally connects to React DevTools via `react-devtools-core`, guarded
// at runtime by `process.env['DEV'] === 'true'`. We never set DEV, so that path
// is dead in production — but the bundler still has to resolve the import. We
// can't `--define` it away (the guard uses bracket access, which define misses)
// and `--external` leaves a top-level ESM import that Node resolves eagerly and
// crashes on. So we resolve `react-devtools-core` to an inert stub instead.
import { chmodSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")

const result = await Bun.build({
  entrypoints: [join(root, "src/index.ts")],
  outdir: join(root, "dist"),
  target: "node",
  plugins: [
    {
      name: "stub-react-devtools-core",
      setup(builder) {
        builder.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: "react-devtools-core",
          namespace: "secapi-stub",
        }))
        builder.onLoad({ filter: /^react-devtools-core$/, namespace: "secapi-stub" }, () => ({
          // Dev-only; never executed in production (guarded by process.env.DEV).
          contents: "export default { connectToDevTools() {} };",
          loader: "js",
        }))
      },
    },
  ],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

chmodSync(join(root, "dist/index.js"), 0o755)
console.log(`built dist/index.js (${result.outputs.length} output(s))`)
