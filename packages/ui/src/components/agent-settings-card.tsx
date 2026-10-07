import type { ReactNode } from "react"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@workspace/ui/components/card"

export function AgentSettingsCard({
  title,
  description,
  children,
  footer,
  action,
  icon,
}: {
  title: string
  description: string
  children: ReactNode
  footer?: ReactNode
  action?: ReactNode
  icon?: ReactNode
}) {
  return (
    <Card className="gap-5 py-6 [--card-spacing:--spacing(6)]">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>
            <h2 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight">
              {icon && (
                <span
                  aria-hidden="true"
                  className="shrink-0 text-muted-foreground [&>svg]:size-5"
                >
                  {icon}
                </span>
              )}
              {title}
            </h2>
          </CardTitle>
          {action}
        </div>
        <CardDescription className="max-w-3xl text-sm leading-relaxed">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
      {footer && (
        <CardFooter className="flex-wrap justify-between gap-3 border-t bg-muted/30 py-4 text-sm text-muted-foreground">
          {footer}
        </CardFooter>
      )}
    </Card>
  )
}
