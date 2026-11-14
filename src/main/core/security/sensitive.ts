import { basename, sep } from 'node:path'

/**
 * Files that commonly hold secrets. Matching is by path shape only (no content read),
 * so it is a guard rail (level 1), never a guarantee.
 */
const SENSITIVE_NAMES = [
  /^\.env(\..+)?$/i, // .env, .env.local… (but see ALLOWED_NAMES)
  /^\.envrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^.*\.(pem|key|p12|pfx|keystore|jks|kdbx|asc|gpg)$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^credentials(\.json)?$/i,
  /^secrets?\.(json|ya?ml|toml)$/i,
  /^auth\.json$/i,
  /^\.pgpass$/i,
]
const ALLOWED_NAMES = [/^\.env\.(example|sample|template|dist)$/i]
const SENSITIVE_DIRS = ['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.config/gcloud', '.azure', 'Library/Keychains', '.codex', '.claude', '.password-store']

export function isSensitivePath(p: string): boolean {
  const name = basename(p)
  if (ALLOWED_NAMES.some((r) => r.test(name))) return false
  if (SENSITIVE_NAMES.some((r) => r.test(name))) return true
  const norm = p.split(sep).join('/')
  return SENSITIVE_DIRS.some((d) => norm.includes(`/${d}/`) || norm.endsWith(`/${d}`))
}

/** Heuristic: does a shell command mention a sensitive location? Level 1 only. */
export function commandTouchesSensitive(command: string): string | null {
  const tokens = command.split(/[\s;|&()<>"'`=]+/).filter(Boolean)
  for (const t of tokens) {
    const cleaned = t.replace(/^~\//, '/HOME/').replace(/^\$HOME\//, '/HOME/').replace(/^\$\{HOME\}\//, '/HOME/')
    if (isSensitivePath(cleaned)) return t
  }
  if (/(^|\s)(printenv|env)(\s|$)/.test(command)) return 'variables d’environnement'
  if (/\bsecurity\s+(find|dump)-/.test(command)) return 'Trousseau macOS'
  return null
}

/** Absolute paths (or ~/…) that appear in a command line. */
export function absolutePathsIn(command: string): string[] {
  const out: string[] = []
  for (const t of command.split(/[\s;|&()<>"'`=]+/)) {
    if (/^\/[^\s]*/.test(t) && !/^\/dev\/(null|stdout|stderr|tty)$/.test(t)) out.push(t)
    else if (/^~(\/|$)/.test(t)) out.push(t.replace(/^~/, process.env.HOME ?? '~'))
  }
  return out
}

/** Redacts credential-looking strings before text crosses an agent boundary (handoffs, logs). */
export function redactSecrets(text: string): { text: string; redactions: number } {
  let redactions = 0
  const rules: RegExp[] = [
    /sk-(ant-)?[A-Za-z0-9_-]{16,}/g,
    /\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    /^([A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*\S+/gim,
  ]
  let out = text
  for (const r of rules) {
    out = out.replace(r, (m, name: unknown) => {
      redactions++
      return typeof name === 'string' && m.includes('=') ? `${name}=[masqué par Orbit]` : '[secret masqué par Orbit]'
    })
  }
  return { text: out, redactions }
}
