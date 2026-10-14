"use client"

import * as React from "react"
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

// Fades the edge that has more tabs past it, so hidden tabs are discoverable.
const edgeFade = (left: boolean, right: boolean) =>
  left || right
    ? `linear-gradient(to right, ${left ? "transparent, #000 2.5rem" : "#000"}, ${right ? "#000 calc(100% - 2.5rem), transparent" : "#000"})`
    : undefined

/**
 * A row that scrolls sideways inside the page instead of widening it: fades
 * the edge that has more past it and starts scrolled to its `[data-active]`
 * (or `[aria-pressed=true]`) item. Returns the mask style for the row.
 */
function useEdgeFade(ref: React.RefObject<HTMLElement | null>) {
  const [more, setMore] = React.useState({ left: false, right: false })
  React.useEffect(() => {
    const row = ref.current
    if (!row) return
    const active = row.querySelector<HTMLElement>(
      "[data-active],[aria-pressed=true]"
    )
    // Clear of the fade too: 40px is its 2.5rem; the browser stops at the end.
    if (active && active.offsetLeft + active.offsetWidth > row.clientWidth)
      row.scrollLeft =
        active.offsetLeft + active.offsetWidth - row.clientWidth + 40
    const update = () =>
      setMore({
        left: row.scrollLeft > 1,
        right: row.scrollLeft + row.clientWidth < row.scrollWidth - 1,
      })
    update()
    row.addEventListener("scroll", update, { passive: true })
    const resize = new ResizeObserver(update)
    resize.observe(row)
    return () => {
      row.removeEventListener("scroll", update)
      resize.disconnect()
    }
  }, [ref])
  const mask = edgeFade(more.left, more.right)
  return { maskImage: mask, WebkitMaskImage: mask }
}

/**
 * A line tab row under a header. When its tabs outgrow a narrow screen it
 * scrolls sideways inside the page instead of widening it, fades the edge
 * that has more tabs, and starts scrolled to the selected tab.
 */
function TabsBar({ className, ...props }: TabsPrimitive.List.Props) {
  const ref = React.useRef<HTMLDivElement>(null)
  const fade = useEdgeFade(ref)
  return (
    <div ref={ref} className="relative overflow-x-auto" style={fade}>
      <TabsList
        variant="line"
        className={cn("w-max min-w-full justify-start border-b", className)}
        {...props}
      />
    </div>
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export {
  Tabs,
  TabsList,
  TabsBar,
  TabsTrigger,
  TabsContent,
  tabsListVariants,
  useEdgeFade,
}
