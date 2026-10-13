"use client"
import {
  ChevronRightIcon,
  CircleXIcon,
  FilePenLineIcon,
  FileTextIcon,
  FolderSearchIcon,
  GlobeIcon,
  Loader2Icon,
  MailIcon,
  MessagesSquareIcon,
  SearchIcon,
  SendIcon,
  TagIcon,
  type LucideIcon,
} from "lucide-react"
import type { TurnStep, TurnStepTool } from "@agentonic/contracts/turn-steps"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import { describeStep } from "@workspace/ui/lib/turn-steps"

const icons: Record<TurnStepTool, LucideIcon> = {
  "gmail.search": SearchIcon,
  "gmail.read": MailIcon,
  "gmail.threads.read": MessagesSquareIcon,
  "gmail.drafts.list": FilePenLineIcon,
  "gmail.drafts.read": FilePenLineIcon,
  "gmail.drafts.create": FilePenLineIcon,
  "gmail.drafts.update": FilePenLineIcon,
  "gmail.drafts.delete": FilePenLineIcon,
  "gmail.send": SendIcon,
  "gmail.labels.apply": TagIcon,
  "drive.files.list": FolderSearchIcon,
  "drive.files.read": FileTextIcon,
  "drive.docs.create": FileTextIcon,
  "drive.docs.update": FileTextIcon,
  "web.search": SearchIcon,
  "web.read": GlobeIcon,
}

function StepList({ steps, live }: { steps: TurnStep[]; live: boolean }) {
  return (
    <ol className="space-y-1.5 text-xs text-muted-foreground">
      {steps.map((step, n) => {
        const Icon =
          step.status === "running" && live
            ? Loader2Icon
            : step.status === "failed"
              ? CircleXIcon
              : icons[step.tool]
        return (
          <li key={n} className="flex items-start gap-2">
            <Icon
              className={`mt-px size-3.5 shrink-0 ${step.status === "running" && live ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            <span className="min-w-0 break-words">
              {describeStep(step, live)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * What a chat or preview turn did, step by step (§74): listed as it happens
 * while the turn runs, then folded into one line above the answer.
 */
export function TurnSteps({
  steps,
  live,
  className,
}: {
  steps: TurnStep[] | null | undefined
  live: boolean
  className?: string
}) {
  if (!steps?.length) return null
  if (live)
    return (
      <div className={className}>
        <StepList steps={steps} live />
      </div>
    )
  return (
    <Collapsible className={className}>
      <CollapsibleTrigger className="group flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        Hizo {steps.length} {steps.length === 1 ? "paso" : "pasos"}
        <ChevronRightIcon
          className="size-3.5 transition-transform group-data-[panel-open]:rotate-90"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <StepList steps={steps} live={false} />
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Whether a running turn is between tool calls, so the model is working. */
export const thinking = (steps: TurnStep[] | null | undefined) =>
  !steps?.some((step) => step.status === "running")
