"use client"
import type { ReactNode } from "react"
import { ArrowUpIcon, PlusIcon } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { Textarea } from "@workspace/ui/components/textarea"

/**
 * Message composer after the Codex composer: the text box on top; below it the
 * attachments button (not available yet), the model control and a round send
 * button. Enter sends and Shift+Enter adds a line. An optional tray under the
 * composer holds the conversation's limits and notes. It hangs from the
 * composer's straight bottom edge rather than tucking under it: the composer
 * is translucent in dark mode, so anything beneath it would show through.
 */
export function ChatComposer({
  id,
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled = false,
  canSubmit,
  maxLength = 1000,
  model,
  tray,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  placeholder: string
  /** Disables writing; the send button follows `canSubmit`. */
  disabled?: boolean
  canSubmit: boolean
  maxLength?: number
  model: ReactNode
  tray?: ReactNode
}) {
  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (canSubmit) onSubmit()
        }}
        className="rounded-3xl border bg-background shadow-sm transition-colors focus-within:border-ring/60 dark:bg-input/30"
      >
        <Textarea
          id={id}
          aria-label="Mensaje"
          value={value}
          maxLength={maxLength}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              if (canSubmit) event.currentTarget.form?.requestSubmit()
            }
          }}
          className="max-h-60 min-h-14 resize-none border-0 bg-transparent px-4 pt-3.5 pb-1 shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="rounded-full"
            disabled
            aria-label="Adjuntar archivos y más (próximamente)"
            title="Próximamente"
          >
            <PlusIcon />
          </Button>
          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            {model}
            <Button
              type="submit"
              size="icon"
              className="rounded-full"
              disabled={!canSubmit}
              aria-label="Enviar mensaje"
            >
              <ArrowUpIcon />
            </Button>
          </div>
        </div>
      </form>
      {tray && (
        <div className="mx-6 rounded-b-2xl bg-muted/60 px-4 pt-2 pb-2.5 text-xs text-muted-foreground">
          {tray}
        </div>
      )}
    </div>
  )
}
