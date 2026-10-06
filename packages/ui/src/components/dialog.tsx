"use client"
import type { ComponentProps } from "react"
import { Dialog as Primitive } from "@base-ui/react/dialog"
import { XIcon } from "lucide-react"
import { cn } from "@workspace/ui/lib/utils"
import { Button } from "@workspace/ui/components/button"

// Nova styling (preset b1zBuS) on the layout every dialog relies on: 24px
// padding (full-bleed footers use -mx-6/-mb-6), a max-w-lg default that a
// className such as max-w-2xl overrides, and scrolling inside the viewport.
export function Dialog(props: Primitive.Root.Props) {
  return <Primitive.Root data-slot="dialog" {...props} />
}
export function DialogTrigger(props: Primitive.Trigger.Props) {
  return <Primitive.Trigger data-slot="dialog-trigger" {...props} />
}
export function DialogPortal(props: Primitive.Portal.Props) {
  return <Primitive.Portal data-slot="dialog-portal" {...props} />
}
export function DialogClose(props: Primitive.Close.Props) {
  return <Primitive.Close data-slot="dialog-close" {...props} />
}
export function DialogOverlay({
  className,
  ...props
}: Primitive.Backdrop.Props) {
  return (
    <Primitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}
export function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: Primitive.Popup.Props & { showCloseButton?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <Primitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl bg-popover p-6 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <Primitive.Close
            data-slot="dialog-close"
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
    </DialogPortal>
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
export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-6 -mb-6 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 px-6 py-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}
export function DialogTitle({ className, ...props }: Primitive.Title.Props) {
  return (
    <Primitive.Title
      data-slot="dialog-title"
      className={cn(
        "pr-8 font-heading text-base leading-none font-medium",
        className
      )}
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
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}
