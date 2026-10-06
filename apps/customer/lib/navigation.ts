import type { NavigationItem } from "@agentonic/contracts/identity"
export const navigation = [
  {
    href: "/",
    title: "Mis espacios",
    description:
      "Espacios a los que tienes acceso para trabajar con tus agentes.",
    group: "Principal",
    enabled: true,
    icon: "home",
  },
  {
    href: "/agents",
    title: "Agentes",
    description: "Configuración y operación de agentes.",
    group: "Mi espacio",
    enabled: true,
    icon: "agents",
  },
  {
    href: "/chats",
    title: "Chats",
    description: "Conversaciones privadas con tus agentes activos.",
    group: "Mi espacio",
    enabled: true,
    icon: "chat",
  },
  {
    href: "/knowledge",
    title: "Conocimiento",
    description: "Documentos y fuentes seleccionadas.",
    group: "Mi espacio",
    enabled: true,
    icon: "knowledge",
  },
  {
    href: "/members",
    title: "Miembros",
    description: "Quién trabaja en el espacio y las invitaciones enviadas.",
    group: "Mi espacio",
    enabled: true,
    icon: "workspaces",
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
export const members = navigation.find((item) => item.href === "/members")!
export const account = navigation[navigation.length - 1]!
