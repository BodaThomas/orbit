import { memo, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import type { HighlighterCore } from 'shiki/core'

let highlighter: Promise<HighlighterCore> | null = null
const LANGS = ['typescript', 'tsx', 'javascript', 'jsx', 'json', 'bash', 'shell', 'python', 'css', 'html', 'markdown', 'sql', 'yaml', 'swift', 'rust', 'go', 'diff']

/** Lazily created; JS regex engine so no WASM is needed under our strict CSP. */
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript')])
    return createHighlighterCore({
      themes: [import('@shikijs/themes/github-dark-default')],
      langs: [
        import('@shikijs/langs/typescript'), import('@shikijs/langs/tsx'), import('@shikijs/langs/javascript'), import('@shikijs/langs/jsx'),
        import('@shikijs/langs/json'), import('@shikijs/langs/bash'), import('@shikijs/langs/shellscript'), import('@shikijs/langs/python'),
        import('@shikijs/langs/css'), import('@shikijs/langs/html'), import('@shikijs/langs/markdown'), import('@shikijs/langs/sql'),
        import('@shikijs/langs/yaml'), import('@shikijs/langs/swift'), import('@shikijs/langs/rust'), import('@shikijs/langs/go'), import('@shikijs/langs/diff'),
      ],
      engine: createJavaScriptRegexEngine(),
    })
  })()
  return highlighter
}

const ALIAS: Record<string, string> = { ts: 'typescript', js: 'javascript', sh: 'bash', zsh: 'bash', py: 'python', yml: 'yaml', md: 'markdown', shell: 'shellscript' }

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const language = ALIAS[lang] ?? lang
  useEffect(() => {
    let alive = true
    if (!LANGS.includes(language) && language !== 'shellscript') return
    const t = setTimeout(() => {
      void getHighlighter().then((h) => {
        if (!alive) return
        try {
          setHtml(h.codeToHtml(code, { lang: language, theme: 'github-dark-default' }))
        } catch {
          setHtml(null)
        }
      })
    }, 120)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [code, language])
  return (
    <div className="group/code relative my-3 overflow-hidden rounded-[10px] bg-[#0d0f14] ring-1 ring-line">
      <div className="flex h-8 items-center justify-between border-b border-line px-3 text-2xs text-fg-3">
        <span className="font-mono">{lang || 'texte'}</span>
        <button
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/5 hover:text-fg"
          onClick={() => {
            void navigator.clipboard.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1400)
          }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />} {copied ? 'Copié' : 'Copier'}
        </button>
      </div>
      {html ? (
        <div className="selectable overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[1.6] [&_pre]:!bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="selectable overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[1.6] text-fg-2">{code}</pre>
      )}
    </div>
  )
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-orbit">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const lang = /language-(\S+)/.exec(className ?? '')?.[1]
            const raw = String(children ?? '')
            if (lang || raw.includes('\n')) return <CodeBlock code={raw.replace(/\n$/, '')} lang={lang ?? ''} />
            return <code>{children}</code>
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
