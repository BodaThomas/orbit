/** French labels for the policy's action families. Shared by the main process and the UI. */
export const CATEGORY_LABELS: Record<string, string> = {
  readonly: 'Inspection en lecture seule',
  verify: 'Test ou vérification',
  build: 'Compilation ou modification locale',
  'git-local': 'Git local',
  network: 'Accès réseau',
  unknown: 'Programme inconnu',
  opaque: 'Effet impossible à déterminer',
  install: 'Installation de dépendances',
  'git-remote': 'Git distant',
  delete: 'Suppression massive',
  'git-destructive': 'Git destructif',
  hooks: 'Hook ou configuration exécutable',
  publish: 'Publication ou action externe',
  database: 'Base de données',
  deploy: 'Déploiement',
  secrets: 'Secrets',
  privileged: 'Action système privilégiée',
  read: 'Lecture',
  edit: 'Modification de fichier',
  'edit-config': 'Configuration exécutée par les tests',
  web: 'Accès web',
  mcp: 'Action externe (MCP)',
  outside: 'Hors du dossier autorisé',
  protected: 'Données protégées',
  command: 'Commande',
}

/** Families that always need a human, whatever the autonomy mode. */
export const SENSITIVE_CATEGORIES = ['install', 'git-remote', 'delete', 'git-destructive', 'hooks', 'publish', 'database', 'deploy', 'secrets', 'privileged', 'outside', 'mcp']

export const SCOPE_LABELS = { once: 'Une fois', mission: 'Pour cette mission', always: 'Toujours (ce compagnon, ce dossier)' } as const

/** What each autonomy mode means, in the words shown to the user. */
export const AUTONOMY_EXPLAINED = {
  manual: {
    label: 'Manuel',
    short: 'Travaille uniquement quand vous le demandez ; chaque modification ou commande attend votre accord.',
    points: ['Missions lancées par vous seulement (jamais par une automatisation)', 'Lectures et recherches dans le dossier : libres', 'Chaque modification, commande ou accès web : votre accord (mémorisable)'],
  },
  supervised: {
    label: 'Supervisé',
    short: 'Mène une mission de développement courante sans vous interrompre ; les actions sensibles vous sont soumises.',
    points: ['Lecture, recherche et modification de fichiers dans le dossier : sans confirmation', 'Inspection, tests, vérifications, compilation, Git local : sans confirmation (bac à sable du moteur)', 'Commandes inconnues et actions sensibles : votre accord'],
  },
  automated: {
    label: 'Automatisé',
    short: 'Exécute des missions prévues en continu dans un périmètre limité, sans demandes répétitives.',
    points: ['Tout ce que permet le mode supervisé, plus les accès web', 'Commandes inconnues : décidées par le mode auto de Claude quand il est actif, sinon bac à sable', 'Actions sensibles : toujours votre accord, même la nuit'],
  },
} as const
