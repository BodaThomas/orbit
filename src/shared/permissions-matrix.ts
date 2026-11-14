import type { Agent, EffectivePermissionRow, ProviderId } from './types'

/**
 * What a companion can *really* do, combining every layer:
 * Orbit's policy (level 1), the engine's own sandbox (level 2) and Orbit's Seatbelt
 * confinement (level 3, only when proven on this Mac). Pure and unit-tested: the profile
 * screen never shows a permission as « refusée » while an equivalent action runs freely.
 */
export function effectivePermissions(agent: Pick<Agent, 'permissions' | 'autonomy' | 'isolation' | 'providerId'>, opts: { isolationProven: boolean }): EffectivePermissionRow[] {
  const p = agent.permissions
  const engine = agent.providerId as ProviderId
  const auto = agent.autonomy === 'automated'
  const strict = agent.isolation === 'strict' && opts.isolationProven
  const isAgent = engine === 'claude-code' || engine === 'claude-agent' || engine === 'codex'
  const confirm = auto ? 'allowed' : 'ask'

  if (!isAgent) {
    const none = (key: EffectivePermissionRow['key'], label: string, companion: boolean): EffectivePermissionRow => ({
      key,
      label,
      companion,
      effective: 'denied',
      enforcedBy: ['engine'],
      detail: 'Fournisseur conversationnel : aucun outil n’existe dans la session, le modèle ne peut que répondre.',
    })
    return [none('read', 'Lire des fichiers', p.readFiles), none('write', 'Modifier des fichiers', p.writeFiles), none('commands', 'Exécuter des commandes', p.runCommands), none('network', 'Accès réseau', p.network), none('external', 'Actions externes', p.externalActions)]
  }

  const rows: EffectivePermissionRow[] = []

  // Read
  if (!p.readFiles) {
    rows.push({
      key: 'read',
      label: 'Lire des fichiers',
      companion: false,
      effective: 'denied',
      enforcedBy: engine === 'codex' ? ['engine'] : ['policy', 'engine'],
      detail: engine === 'codex' ? 'Codex ne peut pas travailler sans lecture : Orbit refuse de démarrer la mission.' : 'Les outils de lecture sont retirés de la session.',
    })
  } else {
    rows.push({
      key: 'read',
      label: 'Lire des fichiers',
      companion: true,
      effective: 'allowed',
      enforcedBy: ['policy'],
      detail:
        engine === 'codex'
          ? 'Codex lit par des commandes en lecture seule (cat, rg, ls…) exécutées dans son bac à sable.'
          : 'Outils Read/Glob/Grep limités au dossier autorisé ; les fichiers sensibles demandent votre accord.',
    })
  }

  // Write
  rows.push(
    !p.writeFiles
      ? { key: 'write', label: 'Modifier des fichiers', companion: false, effective: 'denied', enforcedBy: engine === 'codex' ? ['sandbox', 'policy'] : ['policy', 'engine'], detail: engine === 'codex' ? 'Bac à sable Codex en lecture seule ; toute écriture est refusée par Orbit.' : 'Les outils d’écriture sont retirés de la session.' }
      : {
          key: 'write',
          label: 'Modifier des fichiers',
          companion: true,
          effective: confirm,
          enforcedBy: auto ? ['policy', 'sandbox'] : ['policy', 'approval', 'sandbox'],
          detail: auto ? 'Écritures libres dans le dossier autorisé (mode automatique), bloquées ailleurs.' : 'Chaque écriture attend votre accord, avec le diff.',
        },
  )

  // Commands
  if (!p.runCommands) {
    rows.push(
      engine === 'codex'
        ? {
            key: 'commands',
            label: 'Exécuter des commandes',
            companion: false,
            effective: 'partial',
            enforcedBy: ['engine', 'policy'],
            detail: 'Codex garde ses commandes de lecture jugées sûres (ls, cat, rg…) dans son bac à sable en lecture seule. Toute autre commande lui est refusée — en pratique, Codex renonce souvent à modifier des fichiers dans ce mode (constaté en test réel).',
          }
        : { key: 'commands', label: 'Exécuter des commandes', companion: false, effective: 'denied', enforcedBy: ['policy', 'engine'], detail: 'L’outil Bash n’existe pas dans la session.' },
    )
  } else {
    rows.push({ key: 'commands', label: 'Exécuter des commandes', companion: true, effective: confirm, enforcedBy: auto ? ['policy', 'sandbox'] : ['policy', 'approval', 'sandbox'], detail: auto ? 'Commandes libres dans le bac à sable ; les commandes destructrices ou touchant des secrets demandent votre accord.' : 'Chaque commande attend votre accord.' })
  }

  // Network
  rows.push(
    !p.network
      ? { key: 'network', label: 'Accès réseau', companion: false, effective: 'denied', enforcedBy: ['policy', 'sandbox'], detail: engine === 'codex' ? 'Réseau coupé dans le bac à sable Codex.' : 'Outils web retirés ; le bac à sable des commandes est sans réseau.' }
      : { key: 'network', label: 'Accès réseau', companion: true, effective: confirm, enforcedBy: auto ? ['policy'] : ['policy', 'approval'], detail: 'Recherche et pages web, avec votre accord en mode supervisé.' },
  )

  rows.push({ key: 'external', label: 'Actions externes', companion: p.externalActions, effective: p.externalActions ? 'ask' : 'denied', enforcedBy: ['policy', 'approval'], detail: 'Outils MCP : toujours soumis à validation, même en mode automatique.' })

  // Reads outside the folder: the honest answer depends on the layers present.
  const outsideBlockedByEngine = engine === 'claude-code' || engine === 'claude-agent'
  rows.push({
    key: 'outside',
    label: 'Lire hors du dossier',
    companion: false,
    effective: strict ? 'denied' : outsideBlockedByEngine && !p.runCommands ? 'denied' : 'partial',
    enforcedBy: strict ? ['isolation', 'policy'] : ['policy'],
    detail: strict
      ? 'Isolation renforcée active : le noyau refuse toute lecture de votre dossier personnel hors du projet (auto-test réussi).'
      : outsideBlockedByEngine && !p.runCommands
        ? 'Les outils de lecture sont confinés au dossier et aucune commande n’est possible.'
        : 'Les outils de fichiers sont confinés, mais une commande (même en lecture seule) peut lire ailleurs. Activez l’isolation renforcée pour l’empêcher.',
  })
  rows.push({
    key: 'secrets',
    label: 'Fichiers sensibles (.env, clés SSH)',
    companion: false,
    effective: strict ? 'ask' : 'partial',
    enforcedBy: strict ? ['isolation', 'policy', 'approval'] : ['policy', 'approval'],
    detail: strict
      ? 'Hors du projet : illisibles. Dans le projet : chaque accès demande votre accord.'
      : 'Les accès détectés demandent votre accord, mais la détection d’une commande shell reste heuristique.',
  })
  return rows
}
