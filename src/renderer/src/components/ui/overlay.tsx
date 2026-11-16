import { ContextMenu as CM, Dialog as D, DropdownMenu as DM, Popover as P, Tooltip as T } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

const surface = 'z-50 rounded-lg bg-[#1c1e26] shadow-pop outline-none'


// Popover
export const Popover = P.Root
export const PopoverTrigger = P.Trigger
export const PopoverAnchor = P.Anchor
export function PopoverContent({ className, children, ...props }: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content sideOffset={8} collisionPadding={12} className={cn(surface, 'orbit-pop', className)} {...props}>
        {children}
      </P.Content>
    </P.Portal>
  )
}

// Tooltip
export function Tooltip({ content, children, side = 'top', delay = 350 }: { content: React.ReactNode; children: React.ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; delay?: number }) {
  return (
    <T.Root delayDuration={delay}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="orbit-pop z-[60] max-w-64 rounded-[7px] bg-[#2a2c36] px-2 py-1 text-xs text-fg shadow-pop">
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}
export const TooltipProvider = T.Provider

// Dialog
export const Dialog = D.Root
export const DialogTrigger = D.Trigger
export const DialogClose = D.Close
export function DialogContent({ className, children, title, description, hideClose, ...props }: React.ComponentProps<typeof D.Content> & { title: React.ReactNode; description?: React.ReactNode; hideClose?: boolean }) {
  return (
    <D.Portal>
      <D.Overlay className="orbit-fade fixed inset-0 z-50 bg-[#05060a]/60 backdrop-blur-[2px]" />
      <D.Content
        className={cn(surface, 'orbit-dialog fixed top-1/2 left-1/2 z-50 flex max-h-[86vh] w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col', className)}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
          <div className="min-w-0">
            <D.Title className="text-[15px] font-semibold text-fg">{title}</D.Title>
            {description ? <D.Description className="mt-0.5 text-[13px] text-fg-3">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
          </div>
          {!hideClose && (
            <D.Close className="-mr-1.5 flex size-7 items-center justify-center rounded-sm text-fg-3 hover:bg-white/5 hover:text-fg" aria-label="Fermer">
              <X className="size-4" />
            </D.Close>
          )}
        </div>
        {children}
      </D.Content>
    </D.Portal>
  )
}

// Menus
const item =
  'relative flex h-7 cursor-default select-none items-center gap-2 rounded-[6px] px-2 text-[13px] text-fg-2 outline-none data-[highlighted]:bg-white/[0.06] data-[highlighted]:text-fg data-[disabled]:opacity-40 [&_svg]:size-3.5 [&_svg]:text-fg-3'
const menuSurface = cn(surface, 'orbit-pop min-w-48 p-1')

export const DropdownMenu = DM.Root
export const DropdownMenuTrigger = DM.Trigger
export function DropdownMenuContent({ className, ...props }: React.ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content sideOffset={6} collisionPadding={12} className={cn(menuSurface, className)} {...props} />
    </DM.Portal>
  )
}
export function DropdownMenuItem({ className, danger, ...props }: React.ComponentProps<typeof DM.Item> & { danger?: boolean }) {
  return <DM.Item className={cn(item, danger && 'text-danger data-[highlighted]:text-danger [&_svg]:text-danger', className)} {...props} />
}
export const DropdownMenuSeparator = () => <DM.Separator className="mx-1 my-1 h-px bg-line" />
export const DropdownMenuLabel = ({ children }: { children: React.ReactNode }) => <DM.Label className="px-2 pt-1.5 pb-1 text-2xs font-medium text-fg-3">{children}</DM.Label>

export const ContextMenu = CM.Root
export const ContextMenuTrigger = CM.Trigger
export function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof CM.Content>) {
  return (
    <CM.Portal>
      <CM.Content collisionPadding={12} className={cn(menuSurface, className)} {...props} />
    </CM.Portal>
  )
}
export function ContextMenuItem({ className, danger, ...props }: React.ComponentProps<typeof CM.Item> & { danger?: boolean }) {
  return <CM.Item className={cn(item, danger && 'text-danger data-[highlighted]:text-danger [&_svg]:text-danger', className)} {...props} />
}
export const ContextMenuSeparator = () => <CM.Separator className="mx-1 my-1 h-px bg-line" />

/** Explains why the wrapped control is disabled; a disabled button gets no pointer events, so the span carries the tooltip. */
export function DisabledReason({ reason, children }: { reason: string | null | undefined; children: React.ReactNode }) {
  if (!reason) return <>{children}</>
  return (
    <Tooltip content={reason}>
      <span tabIndex={0} className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/50" aria-label={reason}>
        {children}
      </span>
    </Tooltip>
  )
}
