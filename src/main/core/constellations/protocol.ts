import { z } from 'zod'
import type { Agent, AgentPermissions, ConstellationDefinition, ConstellationLimits, StructuredResult, SubtaskSpec } from '@shared/types'
import { redactSecrets } from '../security/sensitive'

/**
 * The delegation protocol between Orbit and a coordinator, whatever its engine.
 *
 * The coordinator *asks* Orbit to create sub-missions by ending its answer with a fenced
 * `orbit-plan` JSON block. Orbit validates every request (member exists, delegation
 * allowed, limits, dependencies acyclic, permissions within the ceiling) before creating
 * anything. A model can never create a mission by itself, nor raise a permission.
 */

const taskSchema = z.object({
  id: z.string().trim().min(1).max(40),
  assignee: z.string().trim().min(1).max(80),
  objective: z.string().trim().min(1).max(4000),
  expected: z.string().trim().max(2000).default(''),
  context: z.string().max(8000).default(''),
  dependsOn: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  readOnly: z.boolean().default(false),
})
const planSchema = z.object({ tasks: z.array(taskSchema).max(50), note: z.string().max(2000).optional() })

export type PlanTask = z.infer<typeof taskSchema>

export interface PlanValidation {
  tasks: (PlanTask & { agentId: string })[]
  errors: string[]
  /** true when the coordinator chose to answer alone (empty task list or no block). */
  noDelegation: boolean
}

/** Last fenced ```orbit-plan block (or <orbit-plan>…</orbit-plan>) of a message. */
export function extractBlock(text: string, tag: string): string | null {
  const fence = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)```', 'g')
  const xml = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')
  let last: string | null = null
  for (const m of text.matchAll(fence)) last = m[1]!
  if (last == null) for (const m of text.matchAll(xml)) last = m[1]!
  return last?.trim() ?? null
}

/** Kahn's algorithm: returns the keys left in a cycle (empty when acyclic). */
export function findCycle(nodes: { id: string; dependsOn: string[] }[]): string[] {
  const indeg = new Map(nodes.map((n) => [n.id, 0]))
  for (const n of nodes) for (const d of n.dependsOn) if (indeg.has(d)) indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1)
  const queue = [...indeg].filter(([, v]) => v === 0).map(([k]) => k)
  const seen = new Set<string>()
  while (queue.length) {
    const k = queue.shift()!
    seen.add(k)
    for (const n of nodes) if (n.dependsOn.includes(k)) {
      indeg.set(n.id, indeg.get(n.id)! - 1)
      if (indeg.get(n.id) === 0) queue.push(n.id)
    }
  }
  return nodes.map((n) => n.id).filter((id) => !seen.has(id))
}

export function validatePlan(
  text: string,
  ctx: { definition: Pick<ConstellationDefinition, 'coordinatorAgentId' | 'members' | 'limits'>; agents: Pick<Agent, 'id' | 'name' | 'enabled'>[]; alreadyCreated: number; existingKeys: string[]; coordinatorCanDelegate: boolean },
): PlanValidation {
  const block = extractBlock(text, 'orbit-plan')
  if (block == null) return { tasks: [], errors: [], noDelegation: true }
  let json: unknown
  try {
    json = JSON.parse(block)
  } catch {
    return { tasks: [], errors: ['Le plan n’est pas un JSON valide.'], noDelegation: false }
  }
  const parsed = planSchema.safeParse(json)
  if (!parsed.success) return { tasks: [], errors: [`Plan invalide : ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(' ; ')}`], noDelegation: false }
  if (parsed.data.tasks.length === 0) return { tasks: [], errors: [], noDelegation: true }
  if (!ctx.coordinatorCanDelegate) return { tasks: [], errors: ['Ce coordinateur n’est pas autorisé à déléguer.'], noDelegation: false }

  const errors: string[] = []
  const members = new Map(ctx.definition.members.map((m) => [m.agentId, m]))
  const byName = new Map(ctx.agents.map((a) => [a.name.toLowerCase(), a]))
  const byId = new Map(ctx.agents.map((a) => [a.id, a]))
  const keys = new Set<string>()
  const tasks: (PlanTask & { agentId: string })[] = []
  for (const t of parsed.data.tasks) {
    if (keys.has(t.id) || ctx.existingKeys.includes(t.id)) {
      errors.push(`Identifiant en double : ${t.id}.`)
      continue
    }
    keys.add(t.id)
    const agent = byId.get(t.assignee) ?? byName.get(t.assignee.toLowerCase())
    if (!agent) {
      errors.push(`${t.id} : « ${t.assignee} » n’existe pas.`)
      continue
    }
    if (!members.has(agent.id)) {
      errors.push(`${t.id} : ${agent.name} ne fait pas partie de la constellation.`)
      continue
    }
    if (agent.id === ctx.definition.coordinatorAgentId) {
      errors.push(`${t.id} : le coordinateur ne peut pas se déléguer une mission (risque de boucle).`)
      continue
    }
    if (!agent.enabled) {
      errors.push(`${t.id} : ${agent.name} est désactivé.`)
      continue
    }
    tasks.push({ ...t, agentId: agent.id })
  }
  const known = new Set([...keys, ...ctx.existingKeys])
  for (const t of tasks) for (const d of t.dependsOn) if (!known.has(d)) errors.push(`${t.id} dépend de « ${d} », inconnu.`)
  const cycle = findCycle(tasks.map((t) => ({ id: t.id, dependsOn: t.dependsOn.filter((d) => keys.has(d)) })))
  if (cycle.length) errors.push(`Dépendances circulaires : ${cycle.join(' → ')}.`)
  if (ctx.alreadyCreated + tasks.length > ctx.definition.limits.maxSubtasks) errors.push(`Trop de sous-missions : ${ctx.alreadyCreated + tasks.length} demandées au total, limite ${ctx.definition.limits.maxSubtasks}.`)
  return { tasks: errors.length ? [] : tasks, errors, noDelegation: false }
}

const resultSchema = z.object({ status: z.enum(['done', 'partial', 'blocked']).default('done'), summary: z.string().max(8000).default(''), files: z.array(z.string().max(1024)).max(200).default([]) })

export function parseResult(text: string): StructuredResult | null {
  const block = extractBlock(text, 'orbit-result')
  if (!block) return null
  try {
    const r = resultSchema.safeParse(JSON.parse(block))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

const PERM_LABELS: [keyof AgentPermissions, string][] = [
  ['readFiles', 'lire'],
  ['writeFiles', 'modifier des fichiers'],
  ['runCommands', 'exécuter des commandes'],
  ['network', 'accéder au web'],
]
const permText = (p: AgentPermissions) => PERM_LABELS.filter(([k]) => p[k]).map(([, l]) => l).join(', ') || 'répondre uniquement'

export function planningPrompt(o: { goal: string; definition: ConstellationDefinition; agents: Agent[]; engines: Record<string, string>; round: number; limits: ConstellationLimits }): string {
  const roster = o.definition.members
    .filter((m) => m.agentId !== o.definition.coordinatorAgentId)
    .map((m) => {
      const a = o.agents.find((x) => x.id === m.agentId)
      if (!a) return null
      return `- **${a.name}** — rôle : ${m.role || a.role}. ${m.responsibilities} Moteur : ${o.engines[a.id] ?? a.providerId}. Peut : ${permText(a.permissions)}.`
    })
    .filter(Boolean)
    .join('\n')
  return [
    `# Constellation « ${o.definition.name} » — tu coordonnes`,
    o.definition.objective ? `Objectif permanent de la constellation : ${o.definition.objective}` : '',
    `## Demande de l’utilisateur\n${o.goal}`,
    `## Ton équipe\n${roster || '(aucun autre membre)'}`,
    `## Comment déléguer`,
    `Organise le travail : décompose la demande en sous-missions confiées aux membres les plus adaptés. Tu peux d’abord explorer le contexte avec tes propres outils si nécessaire.`,
    `Termine ta réponse par UN bloc de code \`orbit-plan\` contenant du JSON strict :`,
    '```orbit-plan\n{"tasks":[{"id":"recherche","assignee":"<nom du membre>","objective":"…","expected":"résultat attendu","context":"informations utiles à transmettre","dependsOn":[],"readOnly":true}]}\n```',
    `Règles : au plus ${o.limits.maxSubtasks} sous-missions au total, ${o.limits.maxParallel} en parallèle ; « dependsOn » liste les id dont le résultat est nécessaire ; « readOnly »: true si la sous-mission ne doit rien modifier. Tu ne peux pas t’assigner de tâche. Ne transmets jamais de secret, mot de passe ou clé dans « context ».`,
    `Si la demande ne nécessite pas de délégation, réponds directement et termine par \`\`\`orbit-plan\n{"tasks":[]}\n\`\`\`.`,
    `Orbit vérifiera ton plan, lancera les sous-missions, puis te renverra leurs résultats pour la synthèse.`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Context handed to a member: only what the mission needs, secrets masked. */
export function handoffPrompt(o: {
  goal: string
  spec: SubtaskSpec
  coordinatorName: string
  dependencyResults: { key: string; agentName: string; text: string }[]
  workspace: string | null
  permissions: AgentPermissions
}): { prompt: string; redactions: number } {
  let redactions = 0
  const clean = (t: string, max: number) => {
    const r = redactSecrets(t.length > max ? `${t.slice(0, max)}\n…(tronqué par Orbit)` : t)
    redactions += r.redactions
    return r.text
  }
  const prompt = [
    `# Sous-mission confiée par ${o.coordinatorName}`,
    `Contexte général (demande de l’utilisateur) : ${clean(o.goal, 1500)}`,
    `## Ton objectif\n${clean(o.spec.objective, 4000)}`,
    o.spec.expected ? `## Résultat attendu\n${clean(o.spec.expected, 2000)}` : '',
    o.spec.context ? `## Informations transmises\n${clean(o.spec.context, 6000)}` : '',
    ...o.dependencyResults.map((d) => `## Résultat de « ${d.key} » (${d.agentName})\n${clean(d.text, 6000)}`),
    `## Contraintes\n- Dossier autorisé : ${o.workspace ?? 'aucun (réponse uniquement)'}\n- Tu peux : ${permText(o.permissions)}${o.spec.readOnly ? '\n- Sous-mission en lecture seule : ne modifie rien.' : ''}\n- Ne délègue pas à ton tour.`,
    `Termine par un bloc \`orbit-result\` :\n\`\`\`orbit-result\n{"status":"done","summary":"ce que tu as fait et trouvé, en quelques phrases","files":["fichiers modifiés"]}\n\`\`\``,
  ]
    .filter(Boolean)
    .join('\n\n')
  return { prompt, redactions }
}

export function synthesisPrompt(o: { results: { key: string; agentName: string; status: string; text: string }[]; round: number; canDelegateAgain: boolean; remaining: number }): { prompt: string; redactions: number } {
  let redactions = 0
  const body = o.results
    .map((r) => {
      const c = redactSecrets(r.text.length > 8000 ? `${r.text.slice(0, 8000)}\n…(tronqué)` : r.text)
      redactions += c.redactions
      return `## « ${r.key} » — ${r.agentName} · ${r.status}\n${c.text || '(aucun résultat)'}`
    })
    .join('\n\n')
  return {
    prompt: [
      `# Résultats des sous-missions (tour ${o.round})`,
      body,
      o.canDelegateAgain
        ? `Fais la synthèse pour l’utilisateur. Si un complément est indispensable, tu peux déléguer encore (au plus ${o.remaining} sous-missions) avec un nouveau bloc \`orbit-plan\` ; sinon termine par \`\`\`orbit-plan\n{"tasks":[]}\n\`\`\`.`
        : `Rédige maintenant la synthèse finale pour l’utilisateur (aucune nouvelle délégation possible) : ce qui a été fait, par qui, les résultats, les points à vérifier et les prochaines étapes.`,
    ].join('\n\n'),
    redactions,
  }
}

/** The synthesis shown to the user, without the protocol block. */
export function stripProtocol(text: string): string {
  return text
    .replace(/```orbit-(plan|result)\s*\n[\s\S]*?```/g, '')
    .replace(/<orbit-(plan|result)>[\s\S]*?<\/orbit-(plan|result)>/g, '')
    .trim()
}
