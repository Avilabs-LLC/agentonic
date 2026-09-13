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
    description: "Configuración y operación de agentes.",
    group: "Operación",
    enabled: false,
    icon: "agents",
  },
  {
    href: "/submissions",
    title: "Revisiones",
    description: "Propuestas pendientes de revisión.",
    group: "Operación",
    enabled: false,
    icon: "review",
  },
  {
    href: "/activity",
    title: "Actividad",
    description: "Salud y consumo de los agentes.",
    group: "Operación",
    enabled: false,
    icon: "activity",
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
export const home = navigation[0]!
export const account = navigation[navigation.length - 1]!
