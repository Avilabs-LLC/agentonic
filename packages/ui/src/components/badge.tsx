import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-[0.625rem] font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-2.5!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border bg-input/20 text-foreground dark:bg-input/30 [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
        // Acachuchazo status palette: tinted surfaces in light mode;
        // page-background surfaces with luminous text/borders in dark mode.
        // Workflow labels and colors are shared through status-badge.tsx.
        success:
          "border-emerald-200 bg-emerald-100 text-emerald-900 dark:border-emerald-300 dark:bg-background dark:text-emerald-300",
        warning:
          "border-yellow-200 bg-yellow-100 text-yellow-900 dark:border-yellow-300 dark:bg-background dark:text-yellow-300",
        error:
          "border-red-200 bg-red-100 text-red-900 dark:border-red-300 dark:bg-background dark:text-red-300",
        orange:
          "border-orange-200 bg-orange-100 text-orange-900 dark:border-orange-300 dark:bg-background dark:text-orange-300",
        sky: "border-sky-200 bg-sky-100 text-sky-900 dark:border-sky-300 dark:bg-background dark:text-sky-300",
        violet:
          "border-violet-200 bg-violet-100 text-violet-900 dark:border-violet-300 dark:bg-background dark:text-violet-300",
        emerald:
          "border-emerald-200 bg-emerald-100 text-emerald-900 dark:border-emerald-300 dark:bg-background dark:text-emerald-300",
        slate:
          "border-slate-200 bg-slate-100 text-slate-900 dark:border-slate-700 dark:bg-background dark:text-slate-300",
        pink: "border-pink-200 bg-pink-100 text-pink-900 dark:border-pink-300 dark:bg-background dark:text-pink-300",
        indigo:
          "border-indigo-200 bg-indigo-100 text-indigo-900 dark:border-indigo-300 dark:bg-background dark:text-indigo-300",
        teal: "border-teal-200 bg-teal-100 text-teal-900 dark:border-teal-300 dark:bg-background dark:text-teal-300",
        // For colored/hero surfaces where the theme tokens don't apply.
        inverse:
          "border-white/15 bg-white/10 text-white dark:border-white/15 dark:bg-white/10 dark:text-white",
        inverseEmerald:
          "border-emerald-300/20 bg-emerald-400/15 text-emerald-700 dark:border-emerald-300/20 dark:bg-emerald-400/15 dark:text-emerald-200",
        inverseSky:
          "border-sky-300/20 bg-sky-400/15 text-sky-700 dark:border-sky-300/20 dark:bg-sky-400/15 dark:text-sky-200",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
