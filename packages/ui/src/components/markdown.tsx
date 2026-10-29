"use client"
import { useState, type ComponentProps, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "cn"
import { FieldLabel } from "@workspace/ui/components/field"
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@workspace/ui/components/tabs"
import { Textarea } from "@workspace/ui/components/textarea"

// Markdown written by people or models, read in the app. Raw HTML is never
// rendered (react-markdown escapes it) and images show only their alt text, so
// a preview cannot load anything from outside Agentonic.
const components: Components = {
  h1: ({ children }) => (
    <h1 className="mt-5 mb-2 text-lg font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 mb-2 text-base font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-1.5 font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-3 mb-1 font-medium first:mt-0">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="mt-3 mb-1 font-medium first:mt-0">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="mt-3 mb-1 font-medium text-muted-foreground first:mt-0">
      {children}
    </h6>
  ),
  p: ({ children }) => (
    <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>
  ),
  ul: ({ children, className }) => (
    <ul
      className={cn(
        "my-2 space-y-1 pl-5 first:mt-0 last:mb-0",
        className === "contains-task-list" ? "list-none pl-1" : "list-disc"
      )}
    >
      {children}
    </ul>
  ),
  ol: ({ children, start }) => (
    <ol
      start={start}
      className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0"
    >
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="leading-relaxed [&>ol]:my-1 [&>ul]:my-1">{children}</li>
  ),
  input: ({ checked }) => (
    <input
      type="checkbox"
      checked={!!checked}
      disabled
      readOnly
      className="mr-1.5 align-middle"
    />
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-xs">
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
      {children}
    </code>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-link underline underline-offset-4"
    >
      {children}
    </a>
  ),
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  hr: () => <hr className="my-4" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th style={style} className="border px-2 py-1 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border px-2 py-1 align-top">
      {children}
    </td>
  ),
}

// A model's answer may echo links from mail or web pages it read (§81): each
// link shows the site it opens, and only web links can be followed.
const answerComponents: Components = {
  ...components,
  a: ({ children, href }) => {
    const url = URL.canParse(href ?? "") ? new URL(href!) : null
    const host =
      url && (url.protocol === "https:" || url.protocol === "http:")
        ? url.hostname
        : ""
    if (!host) return <span>{children}</span>
    return (
      <>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-link underline underline-offset-4"
        >
          {children}
        </a>
        {!(typeof children === "string" && children.includes(host)) && (
          <span className="text-muted-foreground"> ({host})</span>
        )}
      </>
    )
  },
}

export function Markdown({
  children,
  className,
  answer = false,
}: {
  children: string
  className?: string
  /**
   * A model's answer: single line breaks stay as written, as the answer read
   * before it rendered Markdown, and links name their site.
   */
  answer?: boolean
}) {
  return (
    <div
      className={cn(
        "text-sm break-words",
        answer && "[&_p]:whitespace-pre-line",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={answer ? answerComponents : components}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

const pane =
  "overflow-y-auto rounded-lg border border-input px-3 py-2 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"

/** Vista previa and Texto: the two sides of a Markdown text, as tabs. */
function Sides({
  heading,
  preview,
  text,
  initial,
}: {
  heading: ReactNode
  preview: ReactNode
  text: ReactNode
  initial: "preview" | "text"
}) {
  const [side, setSide] = useState<string>(initial)
  return (
    <Tabs
      value={side}
      onValueChange={(value) => setSide(String(value))}
      className="gap-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {heading}
        <TabsList aria-label="Mostrar el texto" className="ml-auto">
          <TabsTrigger value="preview" className="px-2.5">
            Vista previa
          </TabsTrigger>
          <TabsTrigger value="text" className="px-2.5">
            Texto
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="preview">{preview}</TabsContent>
      <TabsContent value="text" keepMounted>
        {text}
      </TabsContent>
    </Tabs>
  )
}

/**
 * A Markdown text field with two sides: Vista previa renders it, Texto edits
 * the raw text. Both sides share a height bound (`paneClassName`), so a long
 * text scrolls inside the field and the page or dialog around it stays on
 * screen. The textarea stays mounted while the preview shows, keeping a form's
 * registration, undo history and validation.
 */
export function MarkdownField({
  id,
  label,
  markdown,
  paneClassName,
  className,
  ...textarea
}: Omit<ComponentProps<typeof Textarea>, "id"> & {
  id: string
  label: ReactNode
  /** The current text, for the preview. */
  markdown: string
  /** Height bound shared by both sides, e.g. "min-h-52 max-h-[min(28rem,55dvh)]". */
  paneClassName: string
}) {
  return (
    <Sides
      initial={markdown.trim() ? "preview" : "text"}
      heading={<FieldLabel htmlFor={id}>{label}</FieldLabel>}
      preview={
        <div
          role="region"
          aria-label="Vista previa"
          tabIndex={0}
          className={cn(pane, paneClassName)}
        >
          {markdown.trim() ? (
            <Markdown>{markdown}</Markdown>
          ) : (
            <p className="text-sm text-muted-foreground">
              Sin texto todavía. Escríbelo en Texto.
            </p>
          )}
        </div>
      }
      text={
        <Textarea
          id={id}
          className={cn("overflow-y-auto", paneClassName, className)}
          {...textarea}
        />
      }
    />
  )
}

/**
 * Read-only Markdown with the same two sides, for frozen versions: Vista
 * previa renders it, Texto shows it exactly as written. Long text scrolls
 * inside `paneClassName`'s bound.
 */
export function MarkdownView({
  markdown,
  label,
  paneClassName,
  empty = "Sin texto.",
}: {
  markdown: string
  /** Shown left of the tabs, e.g. a skill's name. */
  label?: ReactNode
  paneClassName: string
  empty?: string
}) {
  const text = (body: ReactNode, name: string) => (
    <div
      role="region"
      aria-label={name}
      tabIndex={0}
      className={cn(pane, "bg-muted/20 dark:bg-muted/20", paneClassName)}
    >
      {markdown.trim() ? (
        body
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </div>
  )
  return (
    <Sides
      initial="preview"
      heading={label ?? null}
      preview={text(<Markdown>{markdown}</Markdown>, "Vista previa")}
      text={text(
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
          {markdown}
        </p>,
        "Texto"
      )}
    />
  )
}
