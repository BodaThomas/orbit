import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ToolKind } from '@shared/types'
import { absolutePathsIn, commandTouchesSensitive, isSensitivePath } from '../security/sensitive'
import type { RunPolicy } from './types'

/**
 * Tool policy: the only place that decides whether an agent action runs.
 *
 * It is evaluated by the engine adapters inside the execution path (Claude PreToolUse
 * hook + canUseTool, Codex approval requests), so a model cannot talk its way past it.
 * Pure apart from filesystem path resolution - unit tested.
 */

export interface ToolAction {
  kind: ToolKind
  /** Engine tool name, for messages. */
  name: string
  /** Paths the action touches (absolute or relative to the workspace). */
  paths: string[]
  command?: string
}

export type PolicyDecision = 'allow' | 'ask' | 'deny'

export interface PolicyVerdict {
  decision: PolicyDecision
  reason: string
}

/** Commands that always need a human, even for an automated companion. */
const DANGEROUS_COMMAND =
  /(^|[\s;&|("'`])(sudo|su|rm\s+-[a-zA-Z]*[rf]|git\s+push|git\s+reset\s+--hard|git\s+clean|chmod\s+-R|chown|mkfs|dd\s+if=|shutdown|reboot|launchctl|osascript|security\s|curl[^|]*\|\s*(ba|z)?sh|wget[^|]*\|\s*(ba|z)?sh)(\s|$)/

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

export function isInside(root: string, p: string): boolean {
  const realRoot = existsSync(root) ? realpathSync(root) : resolve(root)
  const target = realResolve(realRoot, p)
  const rel = relative(realRoot, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND.test(command)
}

const deny = (reason: string): PolicyVerdict => ({ decision: 'deny', reason })
const ask = (reason: string): PolicyVerdict => ({ decision: 'ask', reason })
const allow = (reason = 'Autorisé par la politique du compagnon.'): PolicyVerdict => ({ decision: 'allow', reason })

export function evaluateTool(policy: RunPolicy, action: ToolAction): PolicyVerdict {
  const { permissions: p, autonomy, workspace } = policy
  const automated = autonomy === 'automated'
  const outside = action.paths.find((path) => !isInside(workspace, path))
  const sensitive = action.paths.find((path) => isSensitivePath(realResolve(workspace, path)) || isSensitivePath(path))

  switch (action.kind) {
    case 'plan':
      return allow('Outil interne de planification.')
    case 'read':
    case 'search':
      if (!p.readFiles) return deny('Lecture de fichiers non autorisée pour ce compagnon.')
      if (outside) return deny(`Hors du dossier autorisé : ${outside}`)
      // Secrets need a human even for an automated companion.
      if (sensitive) return ask(`Fichier sensible (secrets possibles) : ${sensitive}`)
      return allow()
    case 'edit':
      if (!p.writeFiles) return deny('Modification de fichiers non autorisée pour ce compagnon.')
      if (outside) return deny(`Hors du dossier autorisé : ${outside}`)
      if (sensitive) return ask(`Modification d’un fichier sensible : ${sensitive}`)
      return automated ? allow() : ask('Modification de fichier.')
    case 'command': {
      if (!p.runCommands) return deny('Exécution de commandes non autorisée pour ce compagnon.')
      if (outside) return deny(`Commande lancée hors du dossier autorisé : ${outside}`)
      if (action.command && isDangerousCommand(action.command)) return ask('Commande potentiellement destructrice.')
      const secret = action.command ? commandTouchesSensitive(action.command) : null
      if (secret) return ask(`La commande touche un emplacement sensible : ${secret}`)
      // Level 1 cannot see what a command reads. A path outside the folder in the command
      // line always goes to a human; strict isolation (level 3) blocks the read itself.
      const elsewhere = action.command ? absolutePathsIn(action.command).find((path) => !isInside(workspace, path) && !isSystemPath(path)) : undefined
      if (elsewhere) return ask(`La commande mentionne un chemin hors du dossier : ${elsewhere}`)
      return automated ? allow() : ask('Exécution de commande.')
    }
    case 'web':
      if (!p.network) return deny('Accès réseau non autorisé pour ce compagnon.')
      return automated ? allow() : ask('Accès réseau.')
    case 'mcp':
      if (!p.externalActions) return deny('Actions externes non autorisées pour ce compagnon.')
      return ask('Action externe : toujours soumise à validation.')
    default:
      // Unknown tools fail closed.
      return deny(`Outil « ${action.name} » non pris en charge par Orbit.`)
  }
}

/** Binaries and system folders a command may legitimately name (`/usr/bin/env`, `/tmp`…). */
function isSystemPath(p: string): boolean {
  return /^\/(usr|bin|sbin|opt\/homebrew|System|Library\/Developer|dev|tmp|private\/tmp|var\/folders|private\/var\/folders)(\/|$)/.test(p)
}
