import { afterAll, beforeAll, expect, it } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { latestCreationTemplate } from "../packages/server/src/catalog"
const db = new PGlite()
const tx = {
  $queryRaw: async (sql: TemplateStringsArray) =>
    (await db.query(sql.join(""))).rows,
} as unknown as Parameters<typeof latestCreationTemplate>[0]
beforeAll(async () => {
  await db.exec(`CREATE SCHEMA agentonic;
    CREATE TABLE agentonic.code_releases(id int PRIMARY KEY, template_version_id text, created_at timestamptz, execution_manifest jsonb, allowed boolean);
    CREATE FUNCTION agentonic.can_use_code(int) RETURNS boolean LANGUAGE sql AS 'SELECT allowed FROM agentonic.code_releases WHERE id=$1';
    INSERT INTO agentonic.code_releases VALUES
      (1,'shared-template','2026-09-01','{"previewContract":"1"}',true),
      (2,'shared-template','2026-09-02','{"previewContract":"1"}',true),
      (3,'new-template','2026-09-03','{"previewContract":"1"}',true),
      (4,'authoring-only','2026-09-04','{}',true),
      (5,'not-authorized','2026-09-05','{"previewContract":"1"}',false);`)
})
afterAll(async () => db.close())
it("selects the latest published eligible template, skipping authoring-only and denied releases", async () => {
  expect(await latestCreationTemplate(tx)).toBe("new-template")
})
it("returns one choice even when several runtime releases share a template ID", async () => {
  await db.exec("UPDATE agentonic.code_releases SET allowed=false WHERE id=3")
  expect(await latestCreationTemplate(tx)).toBe("shared-template")
})
it("returns no default when all executable releases are unavailable", async () => {
  await db.exec(
    "UPDATE agentonic.code_releases SET allowed=false WHERE id IN (1,2)"
  )
  expect(await latestCreationTemplate(tx)).toBeNull()
})
