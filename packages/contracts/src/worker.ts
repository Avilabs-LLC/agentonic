import { z } from "zod"
// The first consumer executes only leased knowledge jobs; runtime/deployment work remains disabled.
export const knowledgeJobKind = z.enum(["ingest", "retrieve", "purge"])
