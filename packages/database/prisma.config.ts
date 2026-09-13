import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Only scripts/migrate.mjs supplies this authority. Never fall back to the app URL.
  datasource: { url: process.env.AGENTONIC_MIGRATION_DATABASE_URL },
});
