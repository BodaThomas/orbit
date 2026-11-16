import { useEffect, useState } from 'react'
import { Check, Send } from 'lucide-react'
import { choicesFor, DELEGATE_CHOICE, formatAnswers, isAnswered, type QuestionAnswer } from '@shared/plan-questions'
import type { PlanQuestion } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/field'
import { cn } from '@/lib/cn'
import { useAction } from '@/lib/queries'

const draftKey = (planId: string) => `orbit.decisions.${planId}`

interface Draft {
  answers: QuestionAnswer[]
  comment: string
}

// Answering a long list takes a while: the draft survives a page change or a reload.
function loadDraft(planId: string, count: number): Draft {
  const empty: Draft = { answers: Array.from({ length: count }, () => ({ choices: [], note: '' })), comment: '' }
  try {
    const raw = localStorage.getItem(draftKey(planId))
    if (!raw) return empty
    const d = JSON.parse(raw) as Draft
    if (!Array.isArray(d.answers) || d.answers.length !== count) return empty
    return { answers: d.answers, comment: typeof d.comment === 'string' ? d.comment : '' }
  } catch {
    return empty
  }
}

/**
 * The coordinator's questions as a form: one click per decision, an optional precision, and
 * a single submit. The answer reaches the coordinator as text, question by question.
 */
export function DecisionForm({ runId, planId, questions, canAnswer, submitLabel }: { runId: string; planId: string; questions: PlanQuestion[]; canAnswer: boolean; submitLabel: string }) {
  const [draft, setDraft] = useState<Draft>(() => loadDraft(planId, questions.length))
  const answer = useAction('constellations.answer', {
    success: 'Décisions transmises au coordinateur',
    onSuccess: () => {
      try {
        localStorage.removeItem(draftKey(planId))
      } catch {
        // Storage unavailable: nothing to clean.
      }
    },
  })

  useEffect(() => {
    try {
      localStorage.setItem(draftKey(planId), JSON.stringify(draft))
    } catch {
      // Storage unavailable: the draft simply does not survive a reload.
    }
  }, [planId, draft])

  const setAnswer = (i: number, patch: Partial<QuestionAnswer>) => setDraft((d) => ({ ...d, answers: d.answers.map((a, j) => (j === i ? { ...a, ...patch } : a)) }))

  const toggle = (i: number, q: PlanQuestion, choice: string) => {
    const current = draft.answers[i]?.choices ?? []
    if (current.includes(choice)) return setAnswer(i, { choices: current.filter((c) => c !== choice) })
    // Delegating excludes any other pick, and a single-choice question keeps one pick.
    if (choice === DELEGATE_CHOICE || !q.multiple) return setAnswer(i, { choices: [choice] })
    setAnswer(i, { choices: [...current.filter((c) => c !== DELEGATE_CHOICE), choice] })
  }

  const answered = draft.answers.filter(isAnswered).length
  const missing = questions.length - answered

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (answered) answer.mutate({ id: runId, text: formatAnswers(questions, draft.answers, draft.comment) })
      }}
    >
      <ol className="space-y-2">
        {questions.map((q, i) => {
          const a = draft.answers[i] ?? { choices: [], note: '' }
          const choices = choicesFor(q)
          const done = isAnswered(a)
          return (
            <li key={i} className={cn('rounded-[10px] px-3 py-2.5 ring-1 transition-colors', done ? 'bg-white/[0.02] ring-line' : 'ring-line-strong')}>
              <div className="flex items-start gap-2.5">
                <span className={cn('mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-2xs font-medium', done ? 'bg-success/15 text-success' : 'bg-white/[0.06] text-fg-2')}>
                  {done ? <Check className="size-3" /> : i + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="leading-relaxed text-fg">{q.text}</p>
                  <div className="flex flex-wrap items-center gap-1.5" role={q.multiple ? 'group' : 'radiogroup'} aria-label={`Question ${i + 1}`}>
                    {[...choices, DELEGATE_CHOICE].map((c) => {
                      const on = a.choices.includes(c)
                      return (
                        <button
                          key={c}
                          type="button"
                          role={q.multiple ? 'checkbox' : 'radio'}
                          aria-checked={on}
                          disabled={!canAnswer}
                          onClick={() => toggle(i, q, c)}
                          className={cn(
                            'h-7 rounded-full px-3 text-[13px] ring-1 transition-colors disabled:opacity-40',
                            on ? 'bg-accent/15 text-accent ring-accent/40' : 'text-fg-2 ring-line hover:bg-white/[0.05] hover:text-fg',
                            c === DELEGATE_CHOICE && !on && 'text-fg-3',
                          )}
                        >
                          {c}
                        </button>
                      )
                    })}
                    {q.multiple && <span className="text-2xs text-fg-3">plusieurs choix possibles</span>}
                  </div>
                  <Input
                    className="h-8"
                    value={a.note}
                    disabled={!canAnswer}
                    onChange={(e) => setAnswer(i, { note: e.target.value })}
                    placeholder={choices.length ? 'Préciser (facultatif)…' : 'Votre réponse…'}
                  />
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      <Input value={draft.comment} disabled={!canAnswer} onChange={(e) => setDraft((d) => ({ ...d, comment: e.target.value }))} placeholder="Commentaire général pour le coordinateur (facultatif)…" />
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button type="submit" size="sm" variant="primary" disabled={!canAnswer || !answered || answer.isPending}>
          <Send /> {submitLabel}
        </Button>
        <span className="text-2xs text-fg-3">
          {answered} / {questions.length} répondue{answered > 1 ? 's' : ''}
          {answered > 0 && missing > 0 ? ` · les questions sans réponse seront signalées au coordinateur` : ''}
        </span>
      </div>
    </form>
  )
}
