import { BotIcon } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
// The centered card of the signed-out pages: login, password reset, second
// factor and invitation (architecture §54).
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <BotIcon />
          </span>
          <CardTitle className="text-2xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
        {footer && <CardFooter>{footer}</CardFooter>}
      </Card>
    </main>
  )
}
