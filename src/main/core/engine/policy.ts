import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { GrantScope, ToolKind } from '@shared/types'
import { absolutePathsIn, commandTouchesSensitive, isSensitivePath } from '../security/sensitive'
import { analyzeCommand, CATEGORY_LABELS, normalizeCommand, REVIEW, ROUTINE, type CommandCategory } from './commands'
import type { RunPolicy } from './types'

/**
 * Tool policy: the only place that decides whether an agent action runs.
 *
 * It is evaluated by the engine adapters inside the execution path (Claude PreToolUse
 * hook + canUseTool, Codex approval requests), so a model cannot talk its way past it.
 * Pure apart from filesystem path resolution - unit tested (tests/security.test.ts,
 * tests/permissions.test.ts).
 *
 * Decision table (see docs/PERMISSIONS.md):
 *
 *                         manual   supervised          automated
 *   read / search inside  allow    allow               allow
 *   edit inside           ask      allow               allow
 *   routine command       ask      allow if contained  allow
 *   unknown / opaque      ask      ask                 engine classifier, else contained ? allow : ask
 *   sensitive (install,   ask      ask                 ask
 *     deploy, delete…)
 *   outside the folder    deny for file tools · ask for commands (never grantable)
 *   Orbit's own data      deny, always
 *
 * `autonomous` (full delegation, explicit opt-in): never `ask`. Everything the companion's
 * permission switches allow runs and is logged; Orbit's own data stays refused.
 */

export interface ToolAction {
  kind: ToolKind
  /** Engine tool name, for messages. */
  name: string
  /** Paths the action touches (absolute or relative to the workspace). */
  paths: string[]
  command?: string
  /** URL, search query or MCP tool: what a persistent grant is scoped to. */
  target?: string
}

export type PolicyDecision = 'allow' | 'ask' | 'deny'
export type ActionCategory = CommandCategory | 'read' | 'edit' | 'edit-config' | 'web' | 'mcp' | 'plan' | 'outside' | 'protected'

export interface PolicyVerdict {
  decision: PolicyDecision
  reason: string
  /** Stable rule id, for the audit log and tests. */
  rule: string
  category: ActionCategory
  /**
   * Allowed without a human although it changes something (edit, command, network):
   * recorded in the « done without confirmation » log and notified without blocking.
   */
  routine?: boolean
  /** `ask` only: the widest persistent authorisation the user may give for this exact operation. */
  grant?: { key: string; label: string; max: GrantScope }
  /**
   * `automated` companions only: Orbit has no objection of principle and lets the engine's
   * native classifier (Claude `auto` mode) decide instead of a human, when it is active.
   * `decision` is the fallback when it is not.
   */
  engineMayDecide?: boolean
}

/** Follows symlinks of the longest existing prefix, so `ws/link -> /etc` is caught. */
export function realResolve(root: string, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
  let probe = abs
  const tail: string[] = []
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) return abs
    tail.unshift(probe.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
    probe = parent
  }
  const real = realpathSync(probe)
  return tail.length ? resolve(real, ...tail) : real
}

const realRootOf = (root: string) => (existsSync(root) ? realpathSync(root) : resolve(root))

export function isInside(root: string, p: string): boolean {
  const realRoot = realRootOf(root)
  const target = realResolve(realRoot, p)
  const rel = relative(realRoot, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Kept for callers outside the policy (Codex): true for anything that is not plain routine. */
export function isDangerousCommand(command: string, workspace = process.cwd()): boolean {
  const a = analyzeCommand(command, workspace)
  return !ROUTINE.includes(a.category) && !REVIEW.includes(a.category)
}

const deny = (rule: string, category: ActionCategory, reason: string): PolicyVerdict => ({ decision: 'deny', reason, rule, category })
const ask = (rule: string, category: ActionCategory, reason: string, grant?: PolicyVerdict['grant']): PolicyVerdict => ({ decision: 'ask', reason, rule, category, ...(grant && grant.max !== 'once' ? { grant } : {}) })
const allow = (rule: string, category: ActionCategory, reason: string, routine = false): PolicyVerdict => ({ decision: 'allow', reason, rule, category, ...(routine ? { routine } : {}) })

/** Widest persistent grant per sensitive command family. Secrets and system actions: one at a time. */
const GRANT_MAX: Partial<Record<CommandCategory, GrantScope>> = {
  network: 'always',
  unknown: 'always',
  opaque: 'always',
  readonly: 'always',
  verify: 'always',
  build: 'always',
  'git-local': 'always',
  install: 'always',
  'git-remote': 'always',
  delete: 'mission',
  'git-destructive': 'mission',
  hooks: 'mission',
  publish: 'mission',
  database: 'mission',
  deploy: 'mission',
  secrets: 'once',
  privileged: 'once',
}

/**
 * Files whose content is executed later by tools *outside* the agent's sandbox (Git hooks,
 * the user's own Claude/Codex/editor configuration…). Never edited without a human.
 */
const PERSISTENT_EXEC = [/(^|\/)\.git(\/|$)/, /(^|\/)\.claude\//, /(^|\/)\.codex\//, /(^|\/)\.vscode\//, /(^|\/)\.idea\//, /(^|\/)\.husky\//, /(^|\/)\.github\/workflows\//, /(^|\/)\.gitlab-ci\.ya?ml$/, /(^|\/)\.pre-commit-config\.ya?ml$/, /(^|\/)\.?lefthook\.ya?ml$/, /(^|\/)\.mcp\.json$/, /(^|\/)\.gitmodules$/, /(^|\/)\.gitattributes$/]
/** Files that decide what routine commands (`npm test`, `make`…) actually run. */
const BUILD_EXEC = [/(^|\/)package\.json$/, /(^|\/)(GNU)?[Mm]akefile$/, /(^|\/)[^/]+\.config\.(c|m)?(j|t)s$/, /(^|\/)conftest\.py$/, /(^|\/)setup\.py$/, /(^|\/)pyproject\.toml$/, /(^|\/)build\.rs$/, /(^|\/)Cargo\.toml$/, /(^|\/)[Jj]ustfile$/, /(^|\/)Taskfile\.ya?ml$/, /(^|\/)Rakefile$/, /(^|\/)Gemfile$/, /\.(sh|bash|zsh|command)$/, /(^|\/)\.(npmrc|yarnrc(\.yml)?|nvmrc|tool-versions)$/, /(^|\/)(tox|noxfile)\.(ini|py)$/, /(^|\/)gradle\.(properties|kts?)$/, /(^|\/)build\.gradle(\.kts)?$/, /(^|\/)pom\.xml$/]

export function persistentExecPath(rel: string): boolean {
  return PERSISTENT_EXEC.some((r) => r.test(rel))
}
export function buildExecPath(rel: string): boolean {
  return BUILD_EXEC.some((r) => r.test(rel))
}

/** Binaries and system folders a command may legitimately name (`/usr/bin/env`, `/tmp`…). */
export function isSystemPath(p: string): boolean {
  return /^\/(usr|bin|sbin|opt\/homebrew|System|Library\/Developer|Applications\/Xcode[^/]*\.app|dev|tmp|private\/tmp|var\/folders|private\/var\/folders|etc\/(hosts|shells|paths))(\/|$)/.test(p)
}
const isTempPath = (p: string) => /^\/(tmp|private\/tmp|var\/folders|private\/var\/folders)(\/|$)/.test(p)

const within = (root: string, target: string) => {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function inProtected(policy: RunPolicy, p: string): string | null {
  const ws = realRootOf(policy.workspace)
  const target = realResolve(ws, p)
  for (const root of policy.protectedPaths ?? []) {
    if (!root) continue
    const real = realRootOf(root)
    if (!within(real, target)) continue
    // A constellation worktree lives under Orbit's data folder: its own files stay usable,
    // everything else in that folder (database, grants, engine config) does not.
    if (within(real, ws) && within(ws, target)) continue
    return root
  }
  return null
}

const relTo = (ws: string, p: string) => {
  const real = realRootOf(ws)
  const r = relative(real, realResolve(real, p))
  return r === '' ? '.' : r
}

/**
 * First path written outside the run's write scopes. A sub-mission sharing its folder with
 * others runs side by side with them only because it keeps to its scopes: anything else is
 * refused, never asked, so a parallel writer cannot be overwritten by an approval click.
 */
function outsideScope(policy: RunPolicy, paths: string[]): string | undefined {
  const scopes = policy.writeScopes
  if (!scopes?.length) return undefined
  const ws = realRootOf(policy.workspace)
  // Only writes inside the shared folder compete with other members; the rest has its own rules.
  return paths.filter(Boolean).find((x) => {
    const abs = realResolve(ws, x)
    return isInside(ws, abs) && !scopes.some((root) => isInside(root, abs))
  })
}

const scopeDenial = (policy: RunPolicy, path: string, rule: string) =>
  deny(rule, 'outside', `Hors de la zone d’écriture de cette sous-mission (${(policy.writeScopes ?? []).map((x) => relTo(policy.workspace, x)).join(', ')}) : ${path}. D’autres membres travaillent en parallèle dans ce dossier.`)

export function evaluateTool(policy: RunPolicy, action: ToolAction): PolicyVerdict {
  const { permissions: p, autonomy, workspace } = policy
  const automated = autonomy === 'automated'
  const manual = autonomy === 'manual'
  const contained = policy.commandsContained === true || policy.isolation === 'strict'
  const paths = action.paths.filter(Boolean)

  // Orbit's own data (database, grants, engine configuration): never, whatever the tool.
  const protectedHit = paths.map((x) => inProtected(policy, x)).find(Boolean)
  if (protectedHit) return deny('protected.path', 'protected', `Données d’Orbit protégées : un compagnon ne peut ni lire ni modifier ses propres permissions (${protectedHit}).`)

  if (autonomy === 'autonomous') return evaluateAutonomous(policy, action)

  const outside = paths.find((path) => !isInside(workspace, path))
  const sensitive = paths.find((path) => isSensitivePath(realResolve(workspace, path)) || isSensitivePath(path))

  switch (action.kind) {
    case 'plan':
      return allow('plan', 'plan', 'Outil interne de planification.')
    case 'read':
    case 'search': {
      if (!p.readFiles) return deny('read.disabled', 'read', 'Lecture de fichiers non autorisée pour ce compagnon.')
      if (outside) return deny('read.outside', 'outside', `Hors du dossier autorisé : ${outside}`)
      // Secrets need a human even for an automated companion.
      if (sensitive) return ask('read.sensitive', 'secrets', `Fichier sensible (secrets possibles) : ${sensitive}`, { key: `read:${relTo(workspace, sensitive)}`, label: `Lire ${relTo(workspace, sensitive)}`, max: 'mission' })
      return allow('read.inside', 'read', 'Lecture dans le dossier autorisé.')
    }
    case 'edit': {
      if (!p.writeFiles) return deny('edit.disabled', 'edit', 'Modification de fichiers non autorisée pour ce compagnon.')
      if (outside) return deny('edit.outside', 'outside', `Hors du dossier autorisé : ${outside}`)
      const offScope = outsideScope(policy, paths)
      if (offScope) return scopeDenial(policy, offScope, 'edit.out-of-scope')
      const rels = paths.map((x) => relTo(workspace, x))
      const key = `edit:${rels.join(',')}`
      const label = `Modifier ${rels.join(', ') || 'des fichiers'}`
      if (sensitive) return ask('edit.sensitive', 'secrets', `Modification d’un fichier sensible : ${sensitive}`, { key, label, max: 'once' })
      const hook = rels.find(persistentExecPath)
      if (hook) return ask('edit.persistent-exec', 'hooks', `${hook} est exécuté plus tard par Git, votre éditeur ou un autre outil, hors du bac à sable du compagnon.`, { key, label, max: 'mission' })
      if (manual) return ask('edit.manual', 'edit', 'Mode manuel : chaque modification attend votre accord.', { key, label, max: 'always' })
      const config = rels.find(buildExecPath)
      if (config && !automated && !contained)
        return ask('edit.build-exec', 'edit-config', `${config} décide de ce qu’exécutent les tests et la compilation, et les commandes de ce moteur ne sont pas confinées.`, { key, label, max: 'always' })
      return allow('edit.inside', 'edit', 'Modification dans le dossier autorisé.', true)
    }
    case 'command':
      return evaluateCommand(policy, action, { automated, manual, contained })
    case 'web': {
      if (!p.network) return deny('web.disabled', 'web', 'Accès réseau non autorisé pour ce compagnon.')
      if (automated) return allow('web.automated', 'web', 'Accès web (mode automatique).', true)
      const host = webScope(action)
      return ask('web.ask', 'web', 'Accès réseau.', { key: `web:${host}`, label: host === 'search' ? 'Recherches web' : `Pages web de ${host}`, max: 'always' })
    }
    case 'mcp':
      if (!p.externalActions) return deny('mcp.disabled', 'mcp', 'Actions externes non autorisées pour ce compagnon.')
      return ask('mcp.ask', 'mcp', 'Action externe : toujours soumise à validation.', { key: `mcp:${action.target ?? action.name}`, label: `Outil externe ${action.target ?? action.name}`, max: 'mission' })
    default:
      // Unknown tools fail closed.
      return deny('tool.unknown', 'protected', `Outil « ${action.name} » non pris en charge par Orbit.`)
  }
}

/**
 * Full delegation: no human in the loop, ever. The companion's permission switches still
 * bind (a disabled permission is a refusal, not a question) and Orbit's data stays out of
 * reach; everything else runs and lands in the « done without confirmation » log.
 */
function evaluateAutonomous(policy: RunPolicy, action: ToolAction): PolicyVerdict {
  const { permissions: p, workspace } = policy
  const auto = (rule: string, category: ActionCategory, reason: string, routine = true) => allow(`autonomous.${rule}`, category, `${reason} (autonomie complète)`, routine)
  switch (action.kind) {
    case 'plan':
      return allow('plan', 'plan', 'Outil interne de planification.')
    case 'read':
    case 'search': {
      if (!p.readFiles) return deny('read.disabled', 'read', 'Lecture de fichiers non autorisée pour ce compagnon.')
      const unusual = action.paths.filter(Boolean).find((x) => !isInside(workspace, x) || isSensitivePath(realResolve(workspace, x)) || isSensitivePath(x))
      return auto('read', 'read', unusual ? `Lecture de ${unusual}` : 'Lecture.', Boolean(unusual))
    }
    case 'edit': {
      if (!p.writeFiles) return deny('edit.disabled', 'edit', 'Modification de fichiers non autorisée pour ce compagnon.')
      const offScope = outsideScope(policy, action.paths)
      if (offScope) return scopeDenial(policy, offScope, 'edit.out-of-scope')
      return auto('edit', 'edit', 'Modification de fichier.')
    }
    case 'command': {
      if (!p.runCommands) return deny('command.disabled', 'opaque', 'Exécution de commandes non autorisée pour ce compagnon.')
      const command = action.command ?? ''
      const cwd = action.paths[0] ? realResolve(workspace, action.paths[0]) : workspace
      const a = analyzeCommand(command, realRootOf(workspace), cwd)
      const protectedHit = [...a.paths, ...absolutePathsIn(command), ...action.paths].map((x) => inProtected(policy, x)).find(Boolean)
      if (protectedHit) return deny('command.protected', 'protected', `La commande vise les données d’Orbit (${protectedHit}) : un compagnon ne peut pas modifier ses propres permissions.`)
      const offScope = outsideScope(policy, a.writes)
      if (offScope) return scopeDenial(policy, offScope, 'command.out-of-scope')
      if (a.needs.write && !p.writeFiles && (ROUTINE.includes(a.category) || a.category === 'delete' || a.category === 'git-destructive'))
        return deny('command.needs-write', a.category, `Cette commande modifie des fichiers (${(CATEGORY_LABELS[a.category] ?? a.category).toLowerCase()}) : modification non autorisée pour ce compagnon.`)
      if (a.needs.network && !p.network && a.category !== 'privileged') return deny('command.needs-network', a.category, `Cette commande a besoin du réseau (${a.reason}) : accès réseau non autorisé pour ce compagnon.`)
      return auto(`command.${a.category}`, a.category, `${CATEGORY_LABELS[a.category] ?? 'Commande'} : ${a.reason}`, a.category !== 'readonly')
    }
    case 'web':
      if (!p.network) return deny('web.disabled', 'web', 'Accès réseau non autorisé pour ce compagnon.')
      return auto('web', 'web', 'Accès web.')
    case 'mcp':
      if (!p.externalActions) return deny('mcp.disabled', 'mcp', 'Actions externes non autorisées pour ce compagnon.')
      return auto('mcp', 'mcp', `Action externe ${action.target ?? action.name}.`)
    default:
      return deny('tool.unknown', 'protected', `Outil « ${action.name} » non pris en charge par Orbit.`)
  }
}

function webScope(action: ToolAction): string {
  if (!action.target) return 'search'
  try {
    return new URL(action.target).hostname || 'search'
  } catch {
    return 'search'
  }
}

function evaluateCommand(policy: RunPolicy, action: ToolAction, m: { automated: boolean; manual: boolean; contained: boolean }): PolicyVerdict {
  const { permissions: p, workspace } = policy
  if (!p.runCommands) return deny('command.disabled', 'opaque', 'Exécution de commandes non autorisée pour ce compagnon.')
  const command = action.command ?? ''
  const cwd = action.paths[0] && isInside(workspace, action.paths[0]) ? realResolve(workspace, action.paths[0]) : workspace
  const outsideCwd = action.paths.find((x) => !isInside(workspace, x))
  if (outsideCwd) return deny('command.cwd-outside', 'outside', `Commande lancée hors du dossier autorisé : ${outsideCwd}`)

  const a = analyzeCommand(command, realRootOf(workspace), cwd)
  const key = `command:${normalizeCommand(command)}`
  const short = normalizeCommand(command)
  const label = `Commande « ${short.length > 90 ? `${short.slice(0, 90)}…` : short} »`
  const grantFor = (category: CommandCategory) => ({ key, label, max: GRANT_MAX[category] ?? 'once' })

  // 1. Orbit's own data: refused, whatever the wording.
  const protectedHit = a.paths.map((x) => inProtected(policy, x)).find(Boolean) ?? absolutePathsIn(command).map((x) => inProtected(policy, x)).find(Boolean)
  if (protectedHit) return deny('command.protected', 'protected', `La commande vise les données d’Orbit (${protectedHit}) : un compagnon ne peut pas modifier ses propres permissions.`)

  // 2. Secrets: the path heuristic and the analyser both count.
  const secret = commandTouchesSensitive(command)
  if (secret || a.category === 'secrets') return ask('command.secrets', 'secrets', `La commande touche un emplacement sensible : ${secret ?? a.reason}`, grantFor('secrets'))

  // 3. Missing companion permission for what the command needs.
  if (a.needs.write && !p.writeFiles && (ROUTINE.includes(a.category) || a.category === 'delete' || a.category === 'git-destructive'))
    return deny('command.needs-write', a.category, `Cette commande modifie des fichiers (${(CATEGORY_LABELS[a.category] ?? a.category).toLowerCase()}) : modification non autorisée pour ce compagnon.`)
  if (a.needs.network && !p.network && a.category !== 'privileged') return deny('command.needs-network', a.category, `Cette commande a besoin du réseau (${a.reason}) : accès réseau non autorisé pour ce compagnon.`)

  // 4. Outside the folder: written anywhere → human; read outside system folders → human.
  const outsideWrite = a.writes.find((x) => !isInside(workspace, x) && !isTempPath(x))
  if (outsideWrite) return ask('command.write-outside', 'outside', `La commande écrit hors du dossier autorisé : ${outsideWrite}`)
  const offScope = outsideScope(policy, a.writes)
  if (offScope) return scopeDenial(policy, offScope, 'command.out-of-scope')
  const outsideRead = [...a.paths, ...absolutePathsIn(command)].find((x) => !isInside(workspace, x) && !isSystemPath(x))
  if (outsideRead) return ask('command.outside', 'outside', `La commande mentionne un chemin hors du dossier : ${outsideRead}`)

  // 5. Writes to hooks / tool configuration executed later outside the sandbox.
  if (a.category !== 'readonly') {
    const hook = a.writes.map((x) => relTo(workspace, x)).find((r) => persistentExecPath(r))
    if (hook) return ask('command.hooks', 'hooks', `La commande écrit ${hook}, exécuté plus tard hors du bac à sable.`, grantFor('hooks'))
    const gitInternals = a.segments.some((s) => basename(s.argv[0] ?? '') !== 'git' && s.category !== 'readonly' && s.argv.slice(1).some((x) => /(^|\/)\.git\/(hooks|config)/.test(x)))
    if (gitInternals) return ask('command.hooks', 'hooks', 'La commande modifie les hooks ou la configuration Git.', grantFor('hooks'))
  }

  const cat = a.category
  // 6. Sensitive families: always a human, in every mode.
  if (!ROUTINE.includes(cat) && !REVIEW.includes(cat)) return ask(`command.${cat}`, cat, `${CATEGORY_LABELS[cat]} : ${a.reason}`, grantFor(cat))

  // 7. Unknown effect.
  if (REVIEW.includes(cat)) {
    if (m.automated) {
      const fallback = m.contained ? allow(`command.${cat}.contained`, cat, `${a.reason} Exécutée dans le bac à sable du moteur (mode automatique).`, true) : ask(`command.${cat}`, cat, a.reason, grantFor(cat))
      return { ...fallback, engineMayDecide: true }
    }
    return ask(`command.${cat}`, cat, `${CATEGORY_LABELS[cat]} : ${a.reason}`, grantFor(cat))
  }

  // 8. Routine.
  if (m.manual) return ask('command.manual', cat, `Mode manuel : chaque commande attend votre accord (${a.reason})`, grantFor(cat))
  if (m.automated || cat === 'readonly') return allow(`command.${cat}`, cat, a.reason, cat !== 'readonly')
  if (m.contained) return allow(`command.${cat}`, cat, `${a.reason} Effets limités au dossier par le bac à sable du moteur.`, true)
  return ask(`command.${cat}.uncontained`, cat, `${a.reason} Les commandes de ce moteur ne sont pas confinées : un premier accord est demandé.`, grantFor(cat))
}
