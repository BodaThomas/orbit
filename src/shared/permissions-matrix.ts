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
  const full = agent.autonomy === 'autonomous'
  const auto = agent.autonomy === 'automated' || full
  const manual = agent.autonomy === 'manual'
  const strict = agent.isolation === 'strict' && opts.isolationProven
  const isAgent = engine === 'claude-code' || engine === 'claude-agent' || engine === 'codex'
  const confirm = auto ? 'allowed' : 'ask'
  // Claude engines run approved commands in their own sandbox (writes confined to the folder).
  const contained = engine === 'claude-code' || engine === 'claude-agent' || strict

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
      : manual
        ? { key: 'write', label: 'Modifier des fichiers', companion: true, effective: 'ask', enforcedBy: ['policy', 'approval', 'sandbox'], detail: 'Mode manuel : chaque écriture attend votre accord, avec le diff. Vous pouvez l’autoriser pour la mission ou toujours, fichier par fichier.' }
        : {
            key: 'write',
            label: 'Modifier des fichiers',
            companion: true,
            effective: 'allowed',
            enforcedBy: ['policy', 'sandbox'],
            detail: full ? 'Autonomie complète : toute modification sans confirmation, y compris fichiers sensibles, hooks et configuration d’outils ; seules les données d’Orbit restent refusées.' : `Sans confirmation dans le dossier autorisé, refusé ailleurs. Toujours sur accord : fichiers sensibles (.env, clés), hooks Git et configuration d’outils (.git, .claude, .vscode, .husky)${contained || auto ? '' : ', et fichiers qui décident de ce qu’exécutent les tests (package.json, Makefile, *.config.ts…) car les commandes de Codex ne sont pas confinées'}.`,
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
  } else if (manual) {
    rows.push({ key: 'commands', label: 'Exécuter des commandes', companion: true, effective: 'ask', enforcedBy: ['policy', 'approval', 'sandbox'], detail: 'Mode manuel : chaque commande attend votre accord (autorisable pour la mission ou toujours, commande exacte par commande exacte).' })
  } else {
    rows.push({
      key: 'commands',
      label: 'Exécuter des commandes',
      companion: true,
      effective: auto ? 'allowed' : 'partial',
      enforcedBy: auto ? ['policy', 'sandbox', 'approval'] : ['policy', 'approval', 'sandbox'],
      detail: full
        ? 'Autonomie complète : toute commande s’exécute sans confirmation, hors bac à sable des commandes Claude (le bac à sable Codex reste en écriture dans le dossier, ses escalades sont acceptées par Orbit).'
        : auto
        ? `Commandes courantes sans confirmation${engine === 'codex' ? ' dans le bac à sable Codex' : ''} ; une commande qu’Orbit ne sait pas classer est confiée au mode auto de Claude quand il est actif. Les actions sensibles vous restent soumises.`
        : contained
          ? 'Inspection, tests, vérifications, compilation et Git local sans confirmation, dans le bac à sable du moteur (écritures limitées au dossier). Commandes inconnues et actions sensibles : sur accord.'
          : 'Inspection (ls, git status, rg…) sans confirmation. Tests et compilation : un premier accord, mémorisable « toujours » — les commandes approuvées de Codex ne sont pas confinées. Actions sensibles : sur accord.',
    })
  }

  // Network
  rows.push(
    !p.network
      ? { key: 'network', label: 'Accès réseau', companion: false, effective: 'denied', enforcedBy: ['policy', 'sandbox'], detail: engine === 'codex' ? 'Réseau coupé dans le bac à sable Codex.' : 'Outils web retirés ; le bac à sable des commandes est sans réseau.' }
      : { key: 'network', label: 'Accès réseau', companion: true, effective: confirm, enforcedBy: auto ? ['policy'] : ['policy', 'approval'], detail: auto ? 'Recherche et pages web sans confirmation.' : 'Recherche et pages web sur accord, mémorisable par site (« toujours pour ce compagnon »).' },
  )

  if (full) {
    rows.push({ key: 'sensitive', label: 'Actions sensibles', companion: true, effective: p.runCommands ? 'allowed' : 'denied', enforcedBy: ['policy'], detail: 'Autonomie complète : installations, Git distant ou destructif, suppressions, déploiements, publication, secrets et commandes système s’exécutent sans confirmation, sans bac à sable des commandes Claude, et sont journalisés. Seules les données d’Orbit restent refusées.' })
    rows.push({ key: 'external', label: 'Actions externes', companion: p.externalActions, effective: p.externalActions ? 'allowed' : 'denied', enforcedBy: ['policy'], detail: p.externalActions ? 'Outils MCP sans confirmation (autonomie complète).' : 'Permission désactivée : refusées.' })
    rows.push({ key: 'outside', label: 'Lire hors du dossier', companion: true, effective: strict ? 'denied' : 'allowed', enforcedBy: strict ? ['isolation', 'policy'] : ['policy'], detail: strict ? 'Isolation renforcée active : le noyau refuse les lectures hors du projet, même en autonomie complète.' : 'Autonomie complète : Orbit ne bloque plus les accès hors du dossier (sauf ses propres données) ; le moteur peut encore limiter ses outils de fichiers au dossier.' })
    rows.push({ key: 'secrets', label: 'Fichiers sensibles (.env, clés SSH)', companion: true, effective: strict ? 'partial' : 'allowed', enforcedBy: strict ? ['isolation', 'policy'] : ['policy'], detail: 'Autonomie complète : accès sans confirmation, journalisés.' })
    return rows
  }

  rows.push({
    key: 'sensitive',
    label: 'Actions sensibles',
    companion: true,
    effective: 'ask',
    enforcedBy: ['policy', 'approval'],
    detail: 'Toujours sur accord, quel que soit le mode : suppression massive, Git destructif ou distant, installation de dépendances, déploiement, base de données distante, publication, secrets, commandes système. Jamais d’autorisation permanente pour les secrets et les commandes système.',
  })

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
