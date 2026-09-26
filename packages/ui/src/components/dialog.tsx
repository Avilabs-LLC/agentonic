"use client"
import type { ComponentProps } from "react"
import { Dialog as Primitive } from "@base-ui/react/dialog"
import { XIcon } from "lucide-react"
import { cn } from "@workspace/ui/lib/utils"
import { Button } from "@workspace/ui/components/button"
export const Dialog = Primitive.Root
export const DialogTrigger = Primitive.Trigger
export const DialogClose = Primitive.Close
export function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: Primitive.Popup.Props & { showCloseButton?: boolean }) {
  return (
    <Primitive.Portal>
      <Primitive.Backdrop className="fixed inset-0 z-50 bg-black/80 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs" />
      <Primitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl bg-popover p-6 text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <Primitive.Close
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute top-3 right-3"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Cerrar</span>
          </Primitive.Close>
        )}
      </Primitive.Popup>
    </Primitive.Portal>
  )
}
export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex shrink-0 flex-col gap-2", className)}
      {...props}
    />
  )
}
export function DialogTitle({ className, ...props }: Primitive.Title.Props) {
  return (
    <Primitive.Title
      className={cn("pr-8 text-lg font-semibold", className)}
      {...props}
    />
  )
}
export function DialogDescription({
  className,
  ...props
}: Primitive.Description.Props) {
  return (
    <Primitive.Description
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}
