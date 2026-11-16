import { useState } from 'react'
import { ArrowRight, FlaskConical, Sparkles } from 'lucide-react'
import { COMPANION_PRESETS, DEFAULT_PERMISSIONS, EXPRESSIONS, PALETTE_IDS, PALETTES, SPECIES, TEXTURES } from '@shared/catalog'
import type { Agent, Appearance } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Input, Switch, Textarea } from '@/components/ui/field'
import { call } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useAction, useProviders } from '@/lib/queries'
import { Companion } from '@/orbit/Companion'
import { CompanionAvatar } from '@/orbit/CompanionAvatar'
import { OrbitLogo } from '@/orbit/Logo'
import { Planet } from '@/orbit/Planet'
import { navigate } from '@/stores/router'
import { ProviderConnect } from './Settings'
import { toast } from 'sonner'

const TOTAL = 7

function Stars() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {Array.from({ length: 60 }, (_, i) => {
        const r = Math.sin(i * 91.7) * 10000
        const r2 = Math.sin(i * 47.3) * 10000
        return <span key={i} className="absolute rounded-full bg-white" style={{ left: `${(r - Math.floor(r)) * 100}%`, top: `${(r2 - Math.floor(r2)) * 100}%`, width: i % 9 ? 1 : 1.6, height: i % 9 ? 1 : 1.6, opacity: 0.12 + (i % 6) / 18 }} />
      })}
    </div>
  )
}

export function OnboardingPage() {
  const [step, setStep] = useState(0)
  const [userName, setUserName] = useState('')
  const [name, setName] = useState('Nova')
  const [role, setRole] = useState('Assistante personnelle')
  const [look, setLook] = useState<Appearance>({ ...COMPANION_PRESETS[0].appearance, planet: { ...COMPANION_PRESETS[0].appearance.planet } })
  const [agent, setAgent] = useState<Agent | null>(null)
  const [message, setMessage] = useState('')
  const [sentConversation, setSentConversation] = useState<string | null>(null)
  const [draftConversation, setDraftConversation] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const providers = useProviders()
  const finish = useAction('settings.update')
  const demo = useAction('app.setMode')
  const createAgent = useAction('agents.create')
  const anthropic = providers.data?.find((p) => p.id === 'anthropic')
  const openai = providers.data?.find((p) => p.id === 'openai')
  // The first companion is greeted through chat, so prefer a chat engine: an agent engine needs a folder first.
  const connected = providers.data?.find((p) => p.connected && p.id !== 'demo' && p.capabilities.kind === 'chat') ?? providers.data?.find((p) => p.connected && p.id !== 'demo')

  const next = () => setStep((s) => Math.min(TOTAL - 1, s + 1))

  const create = async () => {
    if (agent) return next()
    const preset = COMPANION_PRESETS.find((p) => p.name === name)
    const providerId = connected?.id ?? 'anthropic'
    const model = connected?.models[0]?.id ?? 'claude-opus-5-5'
    const a = await createAgent.mutateAsync({
      name: name.trim() || 'Nova',
      role,
      description: preset?.description ?? '',
      appearance: look,
      providerId,
      model,
      instructions: preset?.instructions ?? `Tu es ${name}, ${role.toLowerCase()} de l’utilisateur. Tu es clair, chaleureux et concis.`,
      autonomy: 'supervised',
      permissions: { ...DEFAULT_PERMISSIONS },
      workingDirectory: null,
      dailyBudgetUsd: null,
    })
    setAgent(a)
    next()
  }

  const sendFirst = async () => {
    if (!agent || !message.trim()) return next()
    if (sending) return
    setSending(true)
    try {
      // Reuse the conversation of a failed attempt so a retry does not leave an empty one behind.
      const convId = draftConversation ?? (await call('conversations.create', { agentId: agent.id })).id
      setDraftConversation(convId)
      await call('conversations.send', { conversationId: convId, content: message.trim() })
      setSentConversation(convId)
      next()
    } catch (err) {
      toast.error(`Le message n’a pas pu être envoyé : ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSending(false)
    }
  }

  const enter = async () => {
    await finish.mutateAsync({ onboarded: true, userName: userName.trim() })
    if (agent) navigate(sentConversation ? `/chat/${agent.id}/${sentConversation}` : `/chat/${agent.id}`)
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[radial-gradient(ellipse_at_50%_35%,#171a28_0%,#0d0e14_55%,#0b0c10_100%)]">
      <div className="drag absolute inset-x-0 top-0 h-[52px]" />
      <Stars />
      <div className="relative z-10 flex flex-1 items-center justify-center px-8">
        <div key={step} className="orbit-step w-full max-w-[640px] text-center">
          {step === 0 && (
            <>
              <OrbitLogo size={72} className="mx-auto" />
              <h1 className="mt-8 text-[40px] leading-tight font-semibold tracking-[-0.03em] text-fg">Bienvenue dans Orbit</h1>
              <p className="mt-3 text-[16px] text-fg-2">Votre univers personnel d’IA — un endroit calme où retrouver vos compagnons IA.</p>
              <div className="mx-auto mt-8 flex max-w-xs gap-2">
                <Input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Votre prénom" className="h-10 text-[14px]" onKeyDown={(e) => e.key === 'Enter' && next()} autoFocus />
                <Button size="lg" variant="primary" onClick={next}>
                  Commencer <ArrowRight />
                </Button>
              </div>
              <button onClick={() => demo.mutate({ mode: 'demo' })} className="no-drag mt-5 inline-flex items-center gap-1.5 text-[13px] text-fg-3 hover:text-fg">
                <FlaskConical className="size-3.5" /> Explorer d’abord le mode démo, sans clé
              </button>
            </>
          )}

          {step === 1 && (
            <>
              <div className="flex items-end justify-center gap-2">
                {COMPANION_PRESETS.map((p, i) => (
                  <div key={p.key} className="flex flex-col items-center" style={{ transform: `translateY(${[8, -6, -6, 8][i]}px)` }}>
                    <CompanionAvatar appearance={p.appearance} variant="detailed" size={128} seed={p.key} animated />
                    <span className="text-[13px] text-fg">{p.name}</span>
                    <span className="text-2xs text-fg-3">{p.role}</span>
                  </div>
                ))}
              </div>
              <h1 className="mt-8 text-[30px] font-semibold tracking-[-0.02em] text-fg">Construisez votre univers</h1>
              <p className="mx-auto mt-3 max-w-lg text-[15px] leading-relaxed text-fg-2">
                Chaque compagnon a un nom, un rôle, un moteur IA et sa propre planète. Vous leur parlez, leur confiez des missions et suivez leur travail — sans jamais perdre le contrôle.
              </p>
              <Button size="lg" variant="primary" className="mt-8" onClick={next}>
                Continuer <ArrowRight />
              </Button>
            </>
          )}

          {step === 2 && (
            <>
              <h1 className="text-[30px] font-semibold tracking-[-0.02em] text-fg">Connectez un moteur</h1>
              <p className="mx-auto mt-3 max-w-lg text-[15px] text-fg-2">Votre clé est vérifiée puis chiffrée dans le Trousseau macOS. Elle ne quitte jamais Orbit, sauf vers le service concerné.</p>
              <div className="mt-7 divide-y divide-line rounded-2xl bg-surface/90 text-left ring-1 ring-line backdrop-blur">
                {anthropic && <ProviderConnect provider={anthropic} />}
                {openai && <ProviderConnect provider={openai} />}
              </div>
              <div className="mt-6 flex items-center justify-center gap-3">
                <Button size="lg" variant="ghost" onClick={next}>
                  Plus tard
                </Button>
                <Button size="lg" variant="primary" onClick={next} disabled={!connected}>
                  Continuer <ArrowRight />
                </Button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="flex justify-center">
                <Companion appearance={look} size={140} animated />
              </div>
              <h1 className="mt-4 text-[30px] font-semibold tracking-[-0.02em] text-fg">Votre premier compagnon</h1>
              <div className="mx-auto mt-6 grid max-w-md grid-cols-2 gap-2">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom" maxLength={40} className="h-10 text-[14px]" />
                <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Rôle" maxLength={60} className="h-10 text-[14px]" />
              </div>
              <div className="mt-5 flex justify-center gap-2">
                {SPECIES.map((s) => (
                  <button key={s.id} title={s.label} onClick={() => setLook({ ...look, species: s.id })} className={cn('rounded-[12px] p-2 transition-colors', look.species === s.id ? 'bg-accent/[0.12] shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.6)]' : 'hover:bg-white/[0.05]')}>
                    <Companion appearance={{ ...look, species: s.id }} size={44} />
                  </button>
                ))}
              </div>
              <div className="mt-4 flex justify-center gap-2.5">
                {PALETTE_IDS.map((id) => (
                  <button key={id} title={PALETTES[id].label} onClick={() => setLook({ ...look, palette: id, planet: { ...look.planet, palette: id } })} className={cn('size-7 rounded-full transition-transform hover:scale-110', look.palette === id && 'ring-2 ring-fg ring-offset-2 ring-offset-canvas')} style={{ background: `radial-gradient(circle at 35% 30%, ${PALETTES[id].body[0]}, ${PALETTES[id].body[1]} 55%, ${PALETTES[id].body[2]})` }} />
                ))}
              </div>
              <div className="mt-4 flex justify-center gap-1.5">
                {EXPRESSIONS.map((e) => (
                  <button key={e.id} onClick={() => setLook({ ...look, expression: e.id })} className={cn('h-7 rounded-full px-3 text-xs', look.expression === e.id ? 'bg-white/[0.1] text-fg' : 'text-fg-3 hover:text-fg-2')}>
                    {e.label}
                  </button>
                ))}
              </div>
              <Button size="lg" variant="primary" className="mt-8" onClick={next} disabled={!name.trim()}>
                Choisir sa planète <ArrowRight />
              </Button>
            </>
          )}

          {step === 4 && (
            <>
              <div className="flex justify-center">
                <CompanionAvatar appearance={look} variant="profile" size={230} seed="onboarding" animated />
              </div>
              <h1 className="text-[30px] font-semibold tracking-[-0.02em] text-fg">La planète de {name}</h1>
              <div className="mt-6 flex justify-center gap-2">
                {TEXTURES.map((t) => (
                  <button key={t.id} title={t.label} onClick={() => setLook({ ...look, planet: { ...look.planet, texture: t.id } })} className={cn('rounded-[12px] p-1.5', look.planet.texture === t.id ? 'bg-accent/[0.12] shadow-[inset_0_0_0_1.5px_rgb(165_155_250/0.6)]' : 'hover:bg-white/[0.05]')}>
                    <Planet spec={{ ...look.planet, texture: t.id, ring: false, satellite: false }} size={48} seed={t.id} />
                  </button>
                ))}
              </div>
              <div className="mt-4 flex justify-center gap-2.5">
                {PALETTE_IDS.map((id) => (
                  <button key={id} title={PALETTES[id].label} onClick={() => setLook({ ...look, planet: { ...look.planet, palette: id } })} className={cn('size-6 rounded-full', look.planet.palette === id && 'ring-2 ring-fg ring-offset-2 ring-offset-canvas')} style={{ background: `radial-gradient(circle at 35% 30%, ${PALETTES[id].planet[0]}, ${PALETTES[id].planet[1]} 55%, ${PALETTES[id].planet[2]})` }} />
                ))}
              </div>
              <div className="mt-5 flex justify-center gap-6 text-[13px] text-fg-2">
                <label className="flex items-center gap-2"><Switch checked={look.planet.ring} onChange={(v) => setLook({ ...look, planet: { ...look.planet, ring: v } })} label="Anneau" /> Anneau</label>
                <label className="flex items-center gap-2"><Switch checked={look.planet.satellite} onChange={(v) => setLook({ ...look, planet: { ...look.planet, satellite: v } })} label="Satellite" /> Satellite</label>
                <label className="flex items-center gap-2"><Switch checked={look.planet.atmosphere > 0.4} onChange={(v) => setLook({ ...look, planet: { ...look.planet, atmosphere: v ? 0.8 : 0.15 } })} label="Atmosphère" /> Atmosphère</label>
              </div>
              <Button size="lg" variant="primary" className="mt-8" onClick={() => void create()} disabled={createAgent.isPending}>
                <Sparkles /> Donner vie à {name}
              </Button>
            </>
          )}

          {step === 5 && agent && (
            <>
              <div className="flex justify-center">
                <CompanionAvatar appearance={agent.appearance} variant="detailed" size={150} seed={agent.id} animated />
              </div>
              <h1 className="mt-2 text-[30px] font-semibold tracking-[-0.02em] text-fg">Première mission</h1>
              <p className="mt-2 text-[15px] text-fg-2">{connected ? `Dites bonjour à ${agent.name}, ou confiez-lui une première tâche.` : `Connectez un moteur plus tard pour que ${agent.name} puisse vous répondre.`}</p>
              {connected ? (
                <Textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder={`Bonjour ${agent.name} ! Aide-moi à organiser ma semaine.`} className="mx-auto mt-6 min-h-24 max-w-md bg-surface/80 text-[14px]" autoFocus />
              ) : null}
              <div className="mt-6 flex justify-center gap-3">
                <Button size="lg" variant="ghost" onClick={next}>Passer</Button>
                {connected && (
                  <Button size="lg" variant="primary" onClick={() => void sendFirst()} disabled={!message.trim() || sending}>
                    Envoyer <ArrowRight />
                  </Button>
                )}
              </div>
            </>
          )}

          {step === 6 && (
            <>
              <div className="relative mx-auto h-[220px] w-[420px]">
                <svg viewBox="0 0 420 220" className="absolute inset-0" aria-hidden>
                  <ellipse cx="210" cy="120" rx="190" ry="70" fill="none" stroke="#fff" strokeOpacity="0.07" strokeDasharray="2 6" />
                  <circle cx="210" cy="120" r="50" fill="url(#onbcore)" />
                  <defs>
                    <radialGradient id="onbcore"><stop offset="0" stopColor="#A59BFA" stopOpacity="0.35" /><stop offset="1" stopColor="#A59BFA" stopOpacity="0" /></radialGradient>
                  </defs>
                </svg>
                {agent && <div className="absolute top-0 left-[250px]"><CompanionAvatar appearance={agent.appearance} variant="detailed" size={130} seed={agent.id} animated /></div>}
                <OrbitLogo size={36} className="absolute top-[102px] left-[192px]" />
              </div>
              <h1 className="text-[34px] font-semibold tracking-[-0.025em] text-fg">Votre univers est prêt</h1>
              <p className="mt-3 text-[15px] text-fg-2">Astuce : <span className="text-fg">⌘K</span> ouvre la palette de commandes, <span className="text-fg">⌘N</span> crée une mission.</p>
              <Button size="lg" variant="primary" className="mt-8" onClick={() => void enter()}>
                Entrer dans Orbit <ArrowRight />
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="relative z-10 flex justify-center gap-1.5 pb-8" aria-label={`Étape ${step + 1} sur ${TOTAL}`}>
        {Array.from({ length: TOTAL }, (_, i) => (
          <span key={i} className={cn('h-1.5 rounded-full transition-all duration-500 ease-[var(--ease-orbit)]', i === step ? 'w-5 bg-accent' : i < step ? 'w-1.5 bg-fg-3' : 'w-1.5 bg-white/10')} />
        ))}
      </div>
    </div>
  )
}
