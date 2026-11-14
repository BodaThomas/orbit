import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef } from 'react'
import { cn } from '@/lib/cn'

const button = cva(
  'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-[background,color,box-shadow,opacity] duration-150 disabled:pointer-events-none disabled:opacity-40 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-[#14112b] hover:bg-[#b3aafc] active:bg-[#9a8ff5] shadow-[inset_0_1px_0_rgb(255_255_255/0.35)]',
        secondary: 'bg-elevated text-fg hover:bg-hover shadow-[inset_0_0_0_1px_var(--color-line)]',
        ghost: 'text-fg-2 hover:bg-white/[0.05] hover:text-fg',
        outline: 'text-fg shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-white/[0.04]',
        danger: 'bg-danger/12 text-danger hover:bg-danger/20 shadow-[inset_0_0_0_1px_rgb(239_128_138/0.2)]',
        success: 'bg-success/12 text-success hover:bg-success/20 shadow-[inset_0_0_0_1px_rgb(105_201_150/0.2)]',
      },
      size: {
        xs: 'h-6 rounded-[6px] px-2 text-xs [&_svg]:size-3.5',
        sm: 'h-7 rounded-sm px-2.5 text-[13px] [&_svg]:size-3.5',
        md: 'h-8 rounded-md px-3 text-[13px] [&_svg]:size-4',
        lg: 'h-10 rounded-md px-4 text-[14px] [&_svg]:size-4',
        icon: 'size-7 rounded-sm [&_svg]:size-4',
        'icon-sm': 'size-6 rounded-[6px] [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type = 'button', ...props }, ref) => (
  <button ref={ref} type={type} className={cn(button({ variant, size }), className)} {...props} />
))
Button.displayName = 'Button'
