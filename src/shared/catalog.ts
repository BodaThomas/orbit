import type {
  AgentPermissions,
  AgentStatus,
  Appearance,
  Expression,
  PaletteId,
  PlanetTexture,
  Species,
} from './types'

/**
 * Companion & planet palettes. Each palette is a small ramp used by the SVG
 * renderer: `body` gradients for the creature, `planet` gradients for its world.
 */
export interface Palette {
  id: PaletteId
  label: string
  /** creature body: light → mid → deep */
  body: [string, string, string]
  /** planet surface: light → mid → deep */
  planet: [string, string, string]
  /** glow / atmosphere / ring */
  glow: string
  /** solid accent used in UI chips */
  accent: string
}

export const PALETTES: Record<PaletteId, Palette> = {
  lavender: {
    id: 'lavender',
    label: 'Lavande',
    body: ['#D9D2FF', '#A99CF8', '#6E5FD6'],
    planet: ['#E4DEFF', '#B3A8F2', '#5D4FB8'],
    glow: '#B7ACFF',
    accent: '#A59BFA',
  },
  azure: {
    id: 'azure',
    label: 'Azur',
    body: ['#CFE0FF', '#86A7F0', '#3F5FC4'],
    planet: ['#9DB4E8', '#3E5795', '#18244A'],
    glow: '#8FB0FF',
    accent: '#7E9CE8',
  },
  teal: {
    id: 'teal',
    label: 'Lagon',
    body: ['#C9F3EC', '#6FD0C2', '#24917F'],
    planet: ['#CDEFE3', '#7CC9AF', '#2E7A66'],
    glow: '#86E3D2',
    accent: '#5FCDBC',
  },
  amber: {
    id: 'amber',
    label: 'Ambre',
    body: ['#FFE2C2', '#F5A867', '#C9682A'],
    planet: ['#FFD9A8', '#E09A4C', '#8A4A1C'],
    glow: '#FFC08A',
    accent: '#EFA463',
  },
  rose: {
    id: 'rose',
    label: 'Rose',
    body: ['#FFD6E3', '#F293B2', '#C04D78'],
    planet: ['#FBD3E0', '#DB8AA7', '#86385A'],
    glow: '#FFA9C6',
    accent: '#EF8FB0',
  },
  mint: {
    id: 'mint',
    label: 'Menthe',
    body: ['#DFF7D2', '#9ADB7E', '#4E9A3B'],
    planet: ['#E2F5D6', '#A4D48A', '#4C7D3A'],
    glow: '#B5ED98',
    accent: '#93D47A',
  },
  coral: {
    id: 'coral',
    label: 'Corail',
    body: ['#FFD5CC', '#F58F7C', '#C24E3C'],
    planet: ['#FFCDBF', '#E5806B', '#8E3727'],
    glow: '#FFA593',
    accent: '#EF8A78',
  },
  slate: {
    id: 'slate',
    label: 'Ardoise',
    body: ['#E3E5EE', '#A9AEC2', '#5F657E'],
    planet: ['#D5D8E4', '#8D93AB', '#3E435A'],
    glow: '#C3C8DC',
    accent: '#A9AEC2',
  },
}

export const PALETTE_IDS = Object.keys(PALETTES) as PaletteId[]

export const SPECIES: { id: Species; label: string; hint: string }[] = [
  { id: 'round', label: 'Galet', hint: 'Petite créature ronde' },
  { id: 'oval', label: 'Grain', hint: 'Légèrement ovale' },
  { id: 'antenna', label: 'Sonde', hint: 'Petites antennes' },
  { id: 'eared', label: 'Pompon', hint: 'Oreilles arrondies' },
  { id: 'cloud', label: 'Nuage', hint: 'Silhouette nuageuse' },
  { id: 'drop', label: 'Goutte', hint: 'Inspiré d’une goutte' },
]

export const EXPRESSIONS: { id: Expression; label: string }[] = [
  { id: 'welcoming', label: 'Accueillant' },
  { id: 'focused', label: 'Concentré' },
  { id: 'curious', label: 'Curieux' },
  { id: 'calm', label: 'Serein' },
  { id: 'joyful', label: 'Joyeux' },
  { id: 'sleepy', label: 'Rêveur' },
]

export const TEXTURES: { id: PlanetTexture; label: string }[] = [
  { id: 'smooth', label: 'Lisse' },
  { id: 'bands', label: 'Bandes' },
  { id: 'craters', label: 'Cratères' },
  { id: 'facets', label: 'Facettes' },
  { id: 'organic', label: 'Reliefs' },
]

export const STATUS_LABELS: Record<AgentStatus, string> = {
  available: 'Disponible',
  working: 'En mission',
  awaiting_approval: 'Attend votre accord',
  done: 'Mission terminée',
  error: 'Erreur',
  offline: 'Hors ligne',
  disabled: 'Désactivé',
}

export const DEFAULT_PERMISSIONS: AgentPermissions = {
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  network: false,
  manageProjects: false,
  externalActions: false,
}

export const PERMISSION_LABELS: Record<keyof AgentPermissions, { label: string; hint: string; sensitive: boolean }> = {
  readFiles: { label: 'Lecture de fichiers', hint: 'Lire dans le dossier de travail', sensitive: false },
  writeFiles: { label: 'Écriture de fichiers', hint: 'Créer et modifier des fichiers', sensitive: true },
  runCommands: { label: 'Exécution de commandes', hint: 'Lancer des commandes shell', sensitive: true },
  network: { label: 'Accès réseau', hint: 'Requêtes web au-delà du moteur', sensitive: false },
  manageProjects: { label: 'Gestion de projets', hint: 'Créer des missions et sous-missions', sensitive: false },
  externalActions: { label: 'Actions externes', hint: 'E-mails, publications, achats', sensitive: true },
}

export function defaultAppearance(seed = 0): Appearance {
  const palette = PALETTE_IDS[seed % PALETTE_IDS.length] ?? 'lavender'
  const species = SPECIES[seed % SPECIES.length]?.id ?? 'round'
  return {
    species,
    palette,
    expression: 'welcoming',
    planet: { palette, texture: 'smooth', atmosphere: 0.5, ring: false, satellite: false, scale: 1 },
  }
}

/** The four companions used by demo mode and offered as starting templates. */
export const COMPANION_PRESETS = [
  {
    key: 'nova',
    name: 'Nova',
    role: 'Assistante personnelle',
    description: 'Organise, résume et coordonne les autres compagnons.',
    instructions:
      'Tu es Nova, l’assistante personnelle de l’utilisateur. Tu es claire, chaleureuse et concise. Tu proposes des prochaines étapes concrètes.',
    appearance: {
      species: 'round',
      palette: 'lavender',
      expression: 'welcoming',
      planet: { palette: 'lavender', texture: 'smooth', atmosphere: 0.8, ring: true, satellite: false, scale: 1.05 },
    },
  },
  {
    key: 'atlas',
    name: 'Atlas',
    role: 'Développement',
    description: 'Écrit, relit et refactorise du code TypeScript et React.',
    instructions:
      'Tu es Atlas, un ingénieur logiciel senior. Tu réponds avec précision, montres du code minimal et correct, et signales les risques.',
    appearance: {
      species: 'antenna',
      palette: 'azure',
      expression: 'focused',
      planet: { palette: 'azure', texture: 'facets', atmosphere: 0.35, ring: false, satellite: true, scale: 1 },
    },
  },
  {
    key: 'milo',
    name: 'Milo',
    role: 'Recherche',
    description: 'Explore un sujet, compare les sources et synthétise.',
    instructions:
      'Tu es Milo, un chercheur curieux et rigoureux. Tu distingues les faits des hypothèses et tu cites tes sources quand tu en as.',
    appearance: {
      species: 'eared',
      palette: 'teal',
      expression: 'curious',
      planet: { palette: 'teal', texture: 'organic', atmosphere: 0.55, ring: false, satellite: false, scale: 0.95 },
    },
  },
  {
    key: 'echo',
    name: 'Echo',
    role: 'Analyse',
    description: 'Analyse des données, des coûts et des résultats de mission.',
    instructions:
      'Tu es Echo, un analyste calme et méthodique. Tu structures tes réponses avec des chiffres et des conclusions nettes.',
    appearance: {
      species: 'drop',
      palette: 'amber',
      expression: 'calm',
      planet: { palette: 'amber', texture: 'bands', atmosphere: 0.7, ring: false, satellite: false, scale: 1 },
    },
  },
] as const satisfies readonly {
  key: string
  name: string
  role: string
  description: string
  instructions: string
  appearance: Appearance
}[]
