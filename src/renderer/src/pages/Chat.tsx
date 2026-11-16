import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Copy, MessageSquarePlus, MoreHorizontal, Pencil, RotateCcw, Rocket, Search, Square, Trash2, TriangleAlert, UserRound } from 'lucide-react'
import { STATUS_LABELS } from '@shared/catalog'
import type { Agent, Conversation, Message } from '@shared/types'
import { Page, PageLoading } from '@/components/shell/Page'
import { Button } from '@/components/ui/button'
import { Input, Kbd } from '@/components/ui/field'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from '@/components/ui/overlay'
import { cn } from '@/lib/cn'
import { integer, money, relative } from '@/lib/format'
import { useAction, useAgent, useConversations, useMessages, useProviders } from '@/lib/queries'
import { Companion } from '@/orbit/Companion'
import { CompanionAvatar, CompanionStatusIndicator } from '@/orbit/CompanionAvatar'
import { useConfirm, usePrompt } from '@/orbit/Confirm'
import { OrbitEmptyState } from '@/orbit/EmptyState'
import { Markdown } from '@/orbit/Markdown'
import { Planet } from '@/orbit/Planet'
import { ProviderMark } from '@/orbit/ProviderMark'
import { navigate } from '@/stores/router'
import { useUi } from '@/stores/ui'

function ConversationList({ agent, conversations, activeId }: { agent: Agent; conversations: Conversation[]; activeId?: string }) {
  const [q, setQ] = useState('')
  const create = useAction('conversations.create', { onSuccess: (c) => navigate(`/chat/${agent.id}/${c.id}`) })
  const filtered = conversations.filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="flex h-full w-[248px] shrink-0 flex-col border-r border-line">
      <div className="drag h-[52px] shrink-0" />
      <div className="flex items-center gap-2 px-3 pb-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher" className="h-7 pl-7 text-xs" />
        </div>
        <Tooltip content="Nouvelle conversation">
          <Button size="icon" variant="ghost" onClick={() => create.mutate({ agentId: agent.id })} aria-label="Nouvelle conversation">
            <MessageSquarePlus />
          </Button>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-3">
        {filtered.map((c) => (
          <button
            key={c.id}
            onClick={() => navigate(`/chat/${agent.id}/${c.id}`)}
            className={cn('w-full rounded-[9px] px-2.5 py-2 text-left transition-colors', c.id === activeId ? 'bg-surface' : 'hover:bg-white/[0.03]')}
          >
            <div className={cn('truncate text-[13px]', c.id === activeId ? 'text-fg' : 'text-fg-2')}>{c.title}</div>
            <div className="mt-0.5 text-2xs text-fg-3 tabular">
              {relative(c.updatedAt)} · {c.messageCount} message{c.messageCount > 1 ? 's' : ''}
            </div>
          </button>
        ))}
        {conversations.length === 0 && <div className="px-2.5 py-3 text-xs text-fg-3">Aucune conversation pour l’instant.</div>}
      </div>
    </div>
  )
}

function MessageView({ message, agent }: { message: Message; agent: Agent }) {
  const draft = useUi((s) => s.drafts[message.id])
  const text = message.status === 'streaming' ? (draft ?? message.content) : message.content
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="selectable max-w-[78%] rounded-[14px] rounded-br-[5px] bg-elevated px-3.5 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-fg shadow-[inset_0_0_0_1px_var(--color-line)]">
          {message.content}
        </div>
      </div>
    )
  }
  return (
    <div className="group flex gap-3">
      <div className="shrink-0 pt-0.5">
        <Companion appearance={agent.appearance} size={26} status={message.status === 'streaming' ? 'working' : undefined} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-xs text-fg-3">
          <span className="font-medium text-fg-2">{agent.name}</span>
          {message.status === 'streaming' && <span className="text-accent">rédige…</span>}
        </div>
        {text ? (
          <Markdown text={text} />
        ) : message.status === 'streaming' ? (
          <div className="flex h-6 items-center gap-1" aria-label="En réflexion">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-1.5 animate-pulse rounded-full bg-fg-3" style={{ animationDelay: `${i * 160}ms` }} />
            ))}
          </div>
        ) : null}
        {message.status === 'streaming' && text && <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-accent" />}
        {message.status === 'error' && (
          <div className="mt-2 flex items-start gap-2 rounded-[9px] bg-danger/[0.07] px-3 py-2 text-[13px] text-danger ring-1 ring-danger/15">
            <TriangleAlert className="mt-px size-4 shrink-0" /> {message.error ?? 'La réponse a échoué.'}
          </div>
        )}
        {message.status === 'cancelled' && <div className="mt-1.5 text-xs text-fg-3">Réponse interrompue.</div>}
        {message.status !== 'streaming' && (
          <div className="mt-1.5 flex h-6 items-center gap-2 text-2xs text-fg-3 opacity-0 transition-opacity group-hover:opacity-100">
            <button className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-white/5 hover:text-fg" onClick={() => void navigator.clipboard.writeText(message.content)}>
              <Copy className="size-3" /> Copier
            </button>
            {message.outputTokens != null && (
              <span className="tabular" title={message.costKind === 'estimated' ? 'Jetons officiels × tarif public daté' : undefined}>
                {integer(message.inputTokens ?? 0)} → {integer(message.outputTokens)} jetons
                {message.costUsd != null && ` · ${money(message.costUsd, true)}${message.costKind === 'estimated' ? ' estimé' : ''}`}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Composer({ agent, conversationId, streaming, onSent }: { agent: Agent; conversationId?: string; streaming: boolean; onSent: (conversationId: string) => void }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const create = useAction('conversations.create')
  const send = useAction('conversations.send')
  const cancel = useAction('conversations.cancel')
  useEffect(() => ref.current?.focus(), [conversationId])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(220, el.scrollHeight)}px`
  }, [text])

  // Synchronous guard: a second Enter before the first message's conversation exists must not create another one.
  const busy = useRef(false)
  const submit = async () => {
    const content = text.trim()
    if (!content || streaming || busy.current) return
    busy.current = true
    try {
      let id = conversationId
      if (!id) id = (await create.mutateAsync({ agentId: agent.id })).id
      setText('')
      send.mutate({ conversationId: id, content }, { onError: () => setText(content) })
      onSent(id)
    } catch {
      // Already toasted by useAction; the text stays in the composer.
    } finally {
      busy.current = false
    }
  }

  const disabled = !agent.enabled
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pb-5">
      <div className={cn('rounded-[14px] bg-surface p-2 shadow-[0_8px_30px_-12px_rgb(0_0_0/0.6)] ring-1 ring-line transition-shadow focus-within:ring-accent/40', disabled && 'opacity-60')}>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder={disabled ? `${agent.name} est désactivé` : `Écrire à ${agent.name}…`}
          className="block max-h-[220px] w-full resize-none bg-transparent px-2 py-1.5 text-[14px] leading-relaxed text-fg outline-none placeholder:text-fg-3"
        />
        <div className="flex items-center justify-between pt-1 pl-2">
          <span className="text-2xs text-fg-3">
            <Kbd>↵</Kbd> envoyer · <Kbd>⇧↵</Kbd> nouvelle ligne
          </span>
          {streaming ? (
            <Button size="sm" variant="secondary" onClick={() => conversationId && cancel.mutate({ conversationId })}>
              <Square className="fill-current" /> Arrêter
            </Button>
          ) : (
            <Button size="icon" variant="primary" disabled={!text.trim() || disabled} onClick={() => void submit()} aria-label="Envoyer" className="rounded-[9px]">
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

export function ChatPage({ agentId, conversationId }: { agentId: string; conversationId?: string }) {
  const { data: agent, isLoading } = useAgent(agentId)
  const conversations = useConversations(agentId)
  const providers = useProviders()
  const activeId = conversationId ?? conversations.data?.[0]?.id
  const messages = useMessages(activeId)
  const scroller = useRef<HTMLDivElement>(null)
  const drafts = useUi((s) => s.drafts)
  const confirm = useConfirm()
  const prompt = usePrompt()
  const rename = useAction('conversations.rename')
  const remove = useAction('conversations.delete', { onSuccess: () => navigate(`/chat/${agentId}`) })

  const list = useMemo(() => messages.data ?? [], [messages.data])
  const streaming = list.some((m) => m.status === 'streaming')
  const provider = providers.data?.find((p) => p.id === agent?.providerId)
  const conversation = conversations.data?.find((c) => c.id === activeId)
  const draftLen = useMemo(() => list.reduce((n, m) => n + (drafts[m.id]?.length ?? 0), 0), [list, drafts])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (nearBottom || draftLen === 0) el.scrollTo({ top: el.scrollHeight })
  }, [list.length, draftLen])

  if (isLoading) return <PageLoading />
  if (!agent) return <Page><OrbitEmptyState title="Compagnon introuvable" body="Il a peut-être été supprimé." action={<Button variant="secondary" onClick={() => navigate('/companions')}>Voir tous les compagnons</Button>} /></Page>

  const needsKey = provider && provider.availability === 'available' && agent.providerId !== 'demo' && !provider.hasSecret

  return (
    <div className="flex h-full">
      <ConversationList agent={agent} conversations={conversations.data ?? []} activeId={activeId} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="drag flex h-[64px] shrink-0 items-center gap-3 border-b border-line px-6 pt-1">
          <span className="relative">
            <Planet spec={agent.appearance.planet} size={40} seed={agent.id} className="absolute -top-1 -left-1 opacity-60" />
            <Companion appearance={agent.appearance} size={32} status={agent.status} className="relative" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-[15px] font-semibold text-fg">{agent.name}</span>
              <CompanionStatusIndicator status={agent.status} size={7} ring="transparent" />
              <span className="truncate text-xs text-fg-3">{agent.status === 'working' ? (agent.statusText ?? STATUS_LABELS.working) : STATUS_LABELS[agent.status]}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-fg-3">
              <ProviderMark id={agent.providerId} size={14} />
              {provider?.name} · {provider?.models.find((m) => m.id === agent.model)?.label ?? agent.model}
              {conversation && <span className="truncate"> · {conversation.title}</span>}
            </div>
          </div>
          <div className="no-drag ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => navigate(`/companions/${agent.id}`)}>
              <UserRound /> Profil
            </Button>
            {conversation && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" aria-label="Options de la conversation">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={async () => {
                      const title = await prompt('Renommer la conversation', conversation.title)
                      if (title) rename.mutate({ id: conversation.id, title })
                    }}
                  >
                    <Pencil /> Renommer
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    danger
                    onSelect={async () => {
                      if (await confirm({ title: 'Supprimer cette conversation ?', body: 'Les messages seront supprimés définitivement.', confirm: 'Supprimer', danger: true })) remove.mutate({ id: conversation.id })
                    }}
                  >
                    <Trash2 /> Supprimer
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </header>

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          {list.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <CompanionAvatar appearance={agent.appearance} variant="profile" size={168} seed={agent.id} animated status={agent.status} />
              <div className="mt-2 text-[17px] font-semibold text-fg">{agent.name}</div>
              <div className="mt-1 max-w-md text-[13.5px] text-fg-3">{agent.description || agent.role}</div>
              {needsKey && (
                <div className="mt-5 flex items-center gap-3 rounded-[11px] bg-warning/[0.06] px-4 py-3 text-left text-[13px] text-fg-2 ring-1 ring-warning/20">
                  <TriangleAlert className="size-4 shrink-0 text-warning" />
                  {provider?.name} n’est pas connecté.
                  <Button size="xs" variant="secondary" onClick={() => navigate('/settings/providers')}>
                    Connecter
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="mx-auto max-w-[760px] space-y-6 px-6 py-6">
              {list.map((m) => (
                <MessageView key={m.id} message={m} agent={agent} />
              ))}
              {list.at(-1)?.status === 'error' && (
                <div className="flex justify-center">
                  <Button size="xs" variant="ghost" onClick={() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus()}>
                    <RotateCcw /> Écrire un nouveau message
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
        {provider?.capabilities.kind === 'agent' ? (
          <div className="shrink-0 px-6 pb-5">
            <div className="mx-auto flex max-w-[760px] items-center gap-3 rounded-[14px] bg-surface px-4 py-3 ring-1 ring-line">
              <Rocket className="size-4 shrink-0 text-accent" />
              <div className="min-w-0 flex-1 text-[13px] leading-snug text-fg-2">
                {agent.name} travaille avec <span className="text-fg">{provider.name}</span> : il agit dans {agent.workingDirectory ? <span className="font-mono text-xs text-fg">{agent.workingDirectory}</span> : 'son dossier autorisé'} au fil de missions, que vous pouvez suivre et poursuivre.
              </div>
              <Button size="sm" variant="primary" onClick={() => useUi.getState().openNewMission(agent.id)}>
                Confier une mission
              </Button>
            </div>
          </div>
        ) : (
          <Composer agent={agent} conversationId={activeId} streaming={streaming} onSent={(id) => id !== activeId && navigate(`/chat/${agent.id}/${id}`)} />
        )}
      </div>
    </div>
  )
}
