// Builds out/runtime/orbit-runtime.mjs: one file, Node ≥ 22.16, no native module.
// The SQL migrations (embedded by Vite's import.meta.glob in Orbit Desktop) are inlined here.
import process from 'node:process'
import { build } from 'esbuild'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const drizzleDir = join(root, 'drizzle')

const migrations = {
  name: 'orbit-migrations',
  setup(b) {
    b.onLoad({ filter: /infra[\\/]db[\\/]migrations\.ts$/ }, () => {
      const files = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort()
      const entries = files.map((f) => `  ${JSON.stringify(`../../../../drizzle/${f}`)}: ${JSON.stringify(readFileSync(join(drizzleDir, f), 'utf8'))},`)
      return { loader: 'ts', contents: `export const MIGRATION_SOURCES: Record<string, string> = {\n${entries.join('\n')}\n}\n` }
    })
  },
}

// drizzle's better-sqlite3 driver imports the native module to build a client from a path;
// the runtime always passes its own node:sqlite client, so the import is replaced by a stub.
const noNativeSqlite = {
  name: 'no-native-sqlite',
  setup(b) {
    b.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: 'better-sqlite3', namespace: 'orbit-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'orbit-stub' }, () => ({ loader: 'js', contents: "export default class { constructor() { throw new Error('better-sqlite3 n’est pas utilisé par le runtime (node:sqlite).') } }" }))
  },
}

const outfile = join(root, 'out/runtime/orbit-runtime.mjs')
await build({
  entryPoints: [join(root, 'src/runtime/main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile,
  external: ['@anthropic-ai/claude-agent-sdk', '@openai/codex', 'electron'],
  alias: { '@shared': join(root, 'src/shared') },
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [migrations, noNativeSqlite],
  legalComments: 'none',
  logLevel: 'warning',
})
process.stdout.write(`orbit-runtime → ${outfile} (${Math.round(statSync(outfile).size / 1024)} Ko)\n`)
