import type { TurnStep, TurnStepTool } from "@agentonic/contracts/turn-steps"

const quoted = (target: string | null) => (target ? ` «${target}»` : "")
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

/** Each tool's step: while it runs, once done (or proposed), and if it failed. */
const phrases: Record<
  TurnStepTool,
  {
    running: (t: string | null) => string
    done: (t: string | null, count: number | null) => string
    failed: (t: string | null) => string
  }
> = {
  "gmail.search": {
    running: (t) => `Buscando en Gmail${quoted(t)}`,
    done: (t, n) =>
      `Buscó en Gmail${quoted(t)}` +
      (n === null
        ? ""
        : n === 0
          ? " · sin resultados"
          : ` · ${plural(n, "correo", "correos")}`),
    failed: (t) => `No se pudo buscar en Gmail${quoted(t)}`,
  },
  "gmail.read": {
    running: () => "Leyendo un correo",
    done: (t) => (t ? `Leyó${quoted(t)}` : "Leyó un correo"),
    failed: () => "No se pudo leer un correo",
  },
  "gmail.threads.read": {
    running: () => "Leyendo una conversación",
    done: (t, n) =>
      `Leyó la conversación${quoted(t)}` +
      (n ? ` · ${plural(n, "mensaje", "mensajes")}` : ""),
    failed: () => "No se pudo leer una conversación",
  },
  "gmail.drafts.list": {
    running: () => "Revisando los borradores",
    done: (_, n) =>
      "Revisó los borradores" +
      (n === null ? "" : n === 0 ? " · ninguno" : ` · ${n}`),
    failed: () => "No se pudieron revisar los borradores",
  },
  "gmail.drafts.read": {
    running: () => "Leyendo un borrador",
    done: (t) => `Leyó el borrador${quoted(t)}`,
    failed: () => "No se pudo leer un borrador",
  },
  "gmail.drafts.create": {
    running: (t) => `Preparando el borrador${quoted(t)}`,
    done: (t) => `Propuso el borrador${quoted(t)}`,
    failed: (t) => `No se pudo proponer el borrador${quoted(t)}`,
  },
  "gmail.drafts.update": {
    running: (t) => `Preparando cambios al borrador${quoted(t)}`,
    done: (t) => `Propuso editar el borrador${quoted(t)}`,
    failed: (t) => `No se pudo proponer la edición del borrador${quoted(t)}`,
  },
  "gmail.drafts.delete": {
    running: () => "Preparando la eliminación de un borrador",
    done: () => "Propuso eliminar un borrador",
    failed: () => "No se pudo proponer la eliminación de un borrador",
  },
  "gmail.send": {
    running: (t) => `Preparando el envío${quoted(t)}`,
    done: (t) => `Propuso enviar${quoted(t)}`,
    failed: (t) => `No se pudo proponer el envío${quoted(t)}`,
  },
  "gmail.labels.apply": {
    running: (t) => `Preparando etiquetas${quoted(t)}`,
    done: (t, n) =>
      `Propuso etiquetar ${n ? plural(n, "correo", "correos") : "correos"}${quoted(t)}`,
    failed: () => "No se pudieron proponer las etiquetas",
  },
  "drive.files.list": {
    running: (t) => (t ? `Buscando en Drive${quoted(t)}` : "Revisando Drive"),
    done: (t, n) =>
      (t ? `Buscó en Drive${quoted(t)}` : "Revisó los archivos de Drive") +
      (n === null
        ? ""
        : n === 0
          ? " · sin resultados"
          : ` · ${plural(n, "archivo", "archivos")}`),
    failed: () => "No se pudieron revisar los archivos de Drive",
  },
  "drive.files.read": {
    running: () => "Leyendo un archivo de Drive",
    done: (t) => (t ? `Leyó${quoted(t)}` : "Leyó un archivo de Drive"),
    failed: () => "No se pudo leer un archivo de Drive",
  },
  "drive.docs.create": {
    running: (t) => `Preparando el documento${quoted(t)}`,
    done: (t) => `Propuso crear el documento${quoted(t)}`,
    failed: (t) => `No se pudo proponer el documento${quoted(t)}`,
  },
  "drive.docs.update": {
    running: () => "Preparando cambios a un documento",
    done: () => "Propuso editar un documento",
    failed: () => "No se pudo proponer la edición de un documento",
  },
  "web.search": {
    running: (t) => `Buscando en la web${quoted(t)}`,
    done: (t, n) =>
      `Buscó en la web${quoted(t)}` +
      (n === null
        ? ""
        : n === 0
          ? " · sin resultados"
          : ` · ${plural(n, "resultado", "resultados")}`),
    failed: (t) => `No se pudo buscar en la web${quoted(t)}`,
  },
  "web.read": {
    running: (t) => (t ? `Leyendo ${t}` : "Leyendo una página"),
    done: (t) => (t ? `Leyó ${t}` : "Leyó una página"),
    failed: (t) => (t ? `No se pudo leer ${t}` : "No se pudo leer una página"),
  },
}

/** One step as the person reads it (§74). */
export function describeStep(step: TurnStep, live = true) {
  const phrase = phrases[step.tool]
  if (step.status === "failed") return phrase.failed(step.target)
  // A step still open when its turn ended never finished.
  if (step.status === "running")
    return live
      ? phrase.running(step.target)
      : `${phrase.running(step.target)} (sin terminar)`
  return phrase.done(step.target, step.count)
}
