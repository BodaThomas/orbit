import { create } from 'zustand'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/overlay'

interface ConfirmRequest {
  title: string
  body?: string
  confirm?: string
  danger?: boolean
}
interface ConfirmState {
  request: (ConfirmRequest & { resolve: (ok: boolean) => void }) | null
  ask: (r: ConfirmRequest) => Promise<boolean>
}

const useConfirmStore = create<ConfirmState>((set) => ({
  request: null,
  ask: (r) => new Promise((resolve) => set({ request: { ...r, resolve } })),
}))

export const useConfirm = () => useConfirmStore((s) => s.ask)

export function ConfirmHost() {
  const req = useConfirmStore((s) => s.request)
  const close = (ok: boolean) => {
    req?.resolve(ok)
    useConfirmStore.setState({ request: null })
  }
  return (
    <Dialog open={Boolean(req)} onOpenChange={(o) => !o && close(false)}>
      {req && (
        <DialogContent title={req.title} description={req.body} className="w-[420px]" hideClose>
          <div className="flex justify-end gap-2 px-5 pt-2 pb-4">
            <Button variant="ghost" onClick={() => close(false)}>
              Annuler
            </Button>
            <Button variant={req.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
              {req.confirm ?? 'Confirmer'}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}

// Prompt (Electron has no window.prompt)
interface PromptState {
  request: { title: string; value: string; resolve: (v: string | null) => void } | null
  ask: (title: string, value: string) => Promise<string | null>
}
const usePromptStore = create<PromptState>((set) => ({
  request: null,
  ask: (title, value) => new Promise((resolve) => set({ request: { title, value, resolve } })),
}))
export const usePrompt = () => usePromptStore((s) => s.ask)

export function PromptHost() {
  const req = usePromptStore((s) => s.request)
  const close = (v: string | null) => {
    req?.resolve(v)
    usePromptStore.setState({ request: null })
  }
  return (
    <Dialog open={Boolean(req)} onOpenChange={(o) => !o && close(null)}>
      {req && (
        <DialogContent title={req.title} className="w-[420px]" hideClose>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const v = new FormData(e.currentTarget).get('v')
              close(typeof v === 'string' && v.trim() ? v.trim() : null)
            }}
            className="px-5 pb-4"
          >
            <input name="v" defaultValue={req.value} autoFocus className="h-8 w-full rounded-md bg-white/[0.035] px-2.5 text-[13px] text-fg shadow-[inset_0_0_0_1px_var(--color-line)] outline-none focus:shadow-[inset_0_0_0_1px_rgb(165_155_250/0.55)]" />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => close(null)}>Annuler</Button>
              <Button variant="primary" type="submit">Enregistrer</Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  )
}
