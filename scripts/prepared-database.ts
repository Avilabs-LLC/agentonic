import { createHash } from "node:crypto"
import { PGlite } from "@electric-sql/pglite"
import { vector } from "@electric-sql/pglite-pgvector"

// Starting PGlite and replaying every migration takes about a second per test;
// loading a data directory saved after the same SQL takes about 0.2 s. Each
// call still returns its own database: the first call with a given list of
// statements runs them once and saves the result, later calls load a copy.
const saved = new Map<string, Promise<File | Blob>>()

export async function preparedDatabase(statements: string[]) {
  const key = createHash("sha256")
  for (const statement of statements) key.update(statement).update("\0")
  const digest = key.digest("hex")
  let dump = saved.get(digest)
  if (!dump) {
    dump = (async () => {
      const db = new PGlite({ extensions: { vector } })
      try {
        for (const statement of statements) await db.exec(statement)
        return await db.dumpDataDir("none")
      } finally {
        await db.close()
      }
    })()
    saved.set(digest, dump)
  }
  return new PGlite({ loadDataDir: await dump, extensions: { vector } })
}
