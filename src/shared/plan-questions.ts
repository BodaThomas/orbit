import type { PlanQuestion } from './types'

/** Choices offered when the coordinator gave none: most of its questions are yes or no. */
export const DEFAULT_CHOICES = ['Oui', 'Non']
/** Lets the user hand a decision back to the coordinator without writing anything. */
export const DELEGATE_CHOICE = 'À votre jugement'

/**
 * Coordinators often number their questions themselves ("1. Offre : ..."), which doubled the
 * numbering of the list. The prefix carries no meaning once the questions are an array.
 */
export function stripNumbering(text: string): string {
  return text.replace(/^\s*(?:\(?\d{1,2}[.)]|[-*•])\s+/, '').trim()
}

/** Stored questions were plain strings before choices existed: both shapes are read. */
export function normalizeQuestion(q: string | { text?: string; question?: string; options?: string[]; multiple?: boolean }): PlanQuestion {
  if (typeof q === 'string') return { text: stripNumbering(q), options: [], multiple: false }
  const options = [...new Set((q.options ?? []).map((o) => o.trim()).filter(Boolean))]
  return { text: stripNumbering(q.text ?? q.question ?? ''), options, multiple: Boolean(q.multiple) && options.length > 1 }
}

export interface QuestionAnswer {
  choices: string[]
  note: string
}

export const isAnswered = (a: QuestionAnswer | undefined): boolean => Boolean(a && (a.choices.length || a.note.trim()))

/**
 * One block per question, so the coordinator can match each decision to its question even
 * when the user skipped some. Unanswered questions are named, not dropped.
 */
export function formatAnswers(questions: PlanQuestion[], answers: (QuestionAnswer | undefined)[], comment = ''): string {
  const lines = questions.map((q, i) => {
    const a = answers[i]
    if (!isAnswered(a)) return `${i + 1}. ${q.text}\n   → Pas de réponse : ne tranche pas seul, redemande si c’est bloquant.`
    const parts = [a!.choices.join(', '), a!.note.trim()].filter(Boolean)
    return `${i + 1}. ${q.text}\n   → ${parts.join(' · ')}`
  })
  if (comment.trim()) lines.push(`Commentaire général : ${comment.trim()}`)
  return lines.join('\n')
}

/**
 * Questions asked before choices existed carry no options. Offering « Oui / Non » only makes
 * sense when the question is closed: an open French interrogative word rules it out
 * (words like « que » or « qui » are left out: they mostly start relative clauses).
 */
export function looksYesNo(text: string): boolean {
  return /\?\s*$/.test(text) && !/(^|[^\p{L}])(quel(le)?s?|lesquel(le)?s|laquelle|lequel|combien|comment|pourquoi|où)(?=[^\p{L}]|$)/iu.test(text)
}

/** Choices shown for a question: the coordinator's, else yes or no when it reads as closed. */
export const choicesFor = (q: PlanQuestion): string[] => (q.options.length ? q.options : looksYesNo(q.text) ? DEFAULT_CHOICES : [])
