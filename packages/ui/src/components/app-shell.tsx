"use client"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useState } from "react"
import { useTheme } from "next-themes"
import {
  BotIcon,
  MessageSquareIcon,
  HouseIcon,
  ClipboardCheckIcon,
  LibraryIcon,
  PlugIcon,
  ActivityIcon,
  CalendarClockIcon,
  Building2Icon,
  ServerIcon,
  CoinsIcon,
  PackageIcon,
  ChevronsUpDownIcon,
  UserIcon,
  LogOutIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
} from "lucide-react"
import type {
  AppKind,
  NavigationItem,
  ActionResult,
} from "@agentonic/contracts/identity"
import { formatPathSegment } from "@agentonic/contracts/format"
import { APP_NAME, APP_VERSION_LABEL } from "@workspace/ui/lib/version"
import { notify } from "@workspace/ui/lib/toast"
import {
  Sidebar,
  SidebarProvider,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarInset,
  SidebarTrigger,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@workspace/ui/components/sidebar"
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@workspace/ui/components/breadcrumb"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuLabel,
} from "@workspace/ui/components/dropdown-menu"
const icons = {
  home: HouseIcon,
  agents: BotIcon,
  chat: MessageSquareIcon,
  review: ClipboardCheckIcon,
  knowledge: LibraryIcon,
  connections: PlugIcon,
  activity: ActivityIcon,
  expiry: CalendarClockIcon,
  workspaces: Building2Icon,
  deployments: ServerIcon,
  costs: CoinsIcon,
  releases: PackageIcon,
}
export function AppShell({
  app,
  navigation,
  email,
  signOut,
  children,
}: {
  app: AppKind
  navigation: NavigationItem[]
  email: string
  signOut: () => Promise<ActionResult>
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()
  const { setTheme } = useTheme()
  const [busy, setBusy] = useState(false)
  const current = navigation.find((n) => n.href === pathname)
  const parent = navigation.find(
    (n) => n.href !== "/" && pathname.startsWith(`${n.href}/`)
  )
  async function exit() {
    setBusy(true)
    try {
      const result = await signOut()
      if (result.ok) {
        notify.success("Sesión cerrada.")
        router.replace("/login")
        router.refresh()
      } else notify.destructive(result.message)
    } catch {
      notify.destructive("No se pudo cerrar la sesión.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <SidebarProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:bg-background focus:p-4"
      >
        Ir al contenido
      </a>
      <Sidebar variant="inset">
        <SidebarHeader className="p-4">
          <Link href="/" className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <BotIcon className="size-5" />
            </span>
            <span>
              <span className="block font-semibold">{APP_NAME}</span>
              <span className="block text-xs text-muted-foreground">
                {app === "admin" ? "Administración" : "Mi espacio"} ·{" "}
                {APP_VERSION_LABEL}
              </span>
            </span>
          </Link>
        </SidebarHeader>
        <SidebarContent>
          {[
            ...new Set(
              navigation
                .filter((n) => n.href !== "/account")
                .map((n) => n.group)
            ),
          ].map((group) => (
            <SidebarGroup key={group}>
              <SidebarGroupLabel>{group}</SidebarGroupLabel>
              <SidebarMenu>
                {navigation
                  .filter((n) => n.group === group && n.href !== "/account")
                  .map((item) => {
                    const Icon = icons[item.icon]
                    return (
                      <SidebarMenuItem key={item.href}>
                        {item.enabled ? (
                          <SidebarMenuButton
                            isActive={pathname === item.href}
                            render={<Link href={item.href} />}
                          >
                            <Icon />
                            <span>{item.title}</span>
                          </SidebarMenuButton>
                        ) : (
                          <SidebarMenuButton disabled>
                            <Icon />
                            <span>{item.title}</span>
                            <span className="ml-auto text-xs text-muted-foreground">
                              Pronto
                            </span>
                          </SidebarMenuButton>
                        )}
                      </SidebarMenuItem>
                    )
                  })}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter className="p-3">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<SidebarMenuButton className="h-12" />}
            >
              <UserIcon />
              <span className="truncate">{email}</span>
              <ChevronsUpDownIcon className="ml-auto" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" className="min-w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Apariencia</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => setTheme("light")}>
                  <SunIcon />
                  Claro
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("dark")}>
                  <MoonIcon />
                  Oscuro
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("system")}>
                  <MonitorIcon />
                  Sistema
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem render={<Link href="/account" />}>
                <UserIcon />
                Mi cuenta
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={busy} onClick={exit}>
                <LogOutIcon />
                {busy ? "Cerrando sesión…" : "Cerrar sesión"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="flex h-16 items-center gap-3 border-b px-4 md:px-6">
          <SidebarTrigger />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                {pathname === "/" ? (
                  <BreadcrumbPage>
                    {app === "admin" ? "Administración" : "Mi espacio"}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink render={<Link href="/" />}>
                    {app === "admin" ? "Administración" : "Mi espacio"}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {pathname !== "/" && (
                <>
                  <BreadcrumbSeparator />
                  {parent && (
                    <>
                      <BreadcrumbItem>
                        <BreadcrumbLink render={<Link href={parent.href} />}>
                          {parent.title}
                        </BreadcrumbLink>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator />
                    </>
                  )}
                  <BreadcrumbItem>
                    <BreadcrumbPage>
                      {current?.title ??
                        (pathname.endsWith("/new")
                          ? "Crear agente"
                          : pathname.endsWith("/preview")
                            ? "Probar versión"
                            : undefined) ??
                        formatPathSegment(
                          pathname.split("/").filter(Boolean).at(-1) ?? ""
                        )}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <MonitorIcon aria-hidden="true" className="size-3.5" />
            Desarrollo
          </span>
        </header>
        <main
          id="main"
          className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8"
        >
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
