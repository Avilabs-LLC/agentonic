import Link from "next/link"

/**
 * Standard ID cell (visual contract §3): every table whose entity has a
 * detail page opens it by pressing the shortened database id, styled as the
 * classic blue underlined link (ported from corbero-cloud — a documented
 * exception to the semantic-tokens rule, kept in this one component).
 */
export function IdLink({ id, href }: { id: string; href: string }) {
  return (
    <Link
      href={href}
      className="font-mono text-xs text-blue-600 underline underline-offset-4 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
    >
      {id.slice(0, 8)}
    </Link>
  )
}
