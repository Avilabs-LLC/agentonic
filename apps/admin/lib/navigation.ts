import type { NavigationItem } from "@agentonic/contracts/identity"
export const navigation = [
  {
    href: "/",
    title: "Administración",
    description: "Acceso y preparación de la operación de Agentonic.",
    group: "Principal",
    enabled: true,
    icon: "home",
  },
  {
    href: "/agents",
    title: "Agentes",
    description:
      "Todos los agentes, sus capacidades, su despliegue y su actividad.",
    group: "Operación",
    enabled: true,
    icon: "agents",
  },
  {
    href: "/submissions",
    title: "Revisiones",
    description: "Propuestas pendientes de revisión.",
    group: "Operación",
    enabled: true,
    icon: "review",
  },
  {
    href: "/expirations",
    title: "Vencimientos",
    description: "Qué vence, cuándo y quién debe actuar.",
    group: "Operación",
    enabled: true,
    icon: "expiry",
  },
  {
    href: "/deployments",
    title: "Despliegues",
    description: "Despliegues de pruebas y qué ejecuta cada servidor.",
    group: "Operación",
    enabled: true,
    icon: "deployments",
  },
  {
    href: "/activity",
    title: "Actividad",
    description: "Cambios recientes y estado de los turnos de los agentes.",
    group: "Operación",
    enabled: true,
    icon: "activity",
  },
  {
    href: "/costs",
    title: "Costos",
    description: "Gasto por proveedor, espacio de trabajo y agente.",
    group: "Operación",
    enabled: true,
    icon: "costs",
  },
  {
    href: "/workspaces",
    title: "Espacios de trabajo",
    description: "Clientes, sus miembros y el equipo de Agentonic.",
    group: "Plataforma",
    enabled: true,
    icon: "workspaces",
  },
  {
    href: "/runtimes",
    title: "Runtime",
    description: "Versiones publicadas del runtime y dónde están instaladas.",
    group: "Plataforma",
    enabled: true,
    icon: "releases",
  },
  {
    href: "/account",
    title: "Mi cuenta",
    description: "Identidad y acceso a Agentonic.",
    group: "Cuenta",
    enabled: true,
    icon: "home",
  },
] satisfies NavigationItem[]
const at = (href: string) => navigation.find((item) => item.href === href)!
export const home = navigation[0]!
export const expirations = at("/expirations")
export const operations = {
  agents: at("/agents"),
  activity: at("/activity"),
  deployments: at("/deployments"),
  costs: at("/costs"),
  workspaces: at("/workspaces"),
  runtimes: at("/runtimes"),
}
export const account = navigation[navigation.length - 1]!
