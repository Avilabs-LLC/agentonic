import { Markdown } from "@workspace/ui/components/markdown"

export function AgentAnswer({ text }: { text: string }) {
  const marker = "\n\nFuentes web:\n"
  const split = text.lastIndexOf(marker)
  const urls =
    split < 0
      ? []
      : text
          .slice(split + marker.length)
          .split("\n")
          .map((line) => line.replace(/^• /, ""))
  const valid =
    urls.length > 0 &&
    urls.length <= 3 &&
    urls.every((value) => {
      try {
        const u = new URL(value)
        return u.protocol === "https:" && !u.username && !u.password
      } catch {
        return false
      }
    })
  return (
    <div className="space-y-3">
      <Markdown answer>{valid ? text.slice(0, split) : text}</Markdown>
      {valid && (
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">
            Fuentes web
          </p>
          <ul className="space-y-1 text-sm">
            {urls.map((url) => (
              <li key={url}>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-link underline underline-offset-4"
                >
                  {new URL(url).hostname}
                  {new URL(url).pathname === "/" ? "" : new URL(url).pathname}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
