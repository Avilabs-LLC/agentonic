"use client"
import type { ReactNode } from "react"
import { useSearchParams } from "next/navigation"
import {
  Tabs,
  TabsBar,
  TabsTrigger,
  TabsContent,
} from "@workspace/ui/components/tabs"
export function AgentPageTabs({
  configuration,
  proposals,
  activation,
  schedules,
}: {
  configuration: ReactNode
  proposals?: ReactNode
  activation?: ReactNode
  /** Programaciones (§58), for members who can use the agent. */
  schedules?: ReactNode
}) {
  const params = useSearchParams()
  return (
    <Tabs
      value={
        params.get("tab") === "activacion" && activation
          ? "activacion"
          : params.get("tab") === "programaciones" && schedules
            ? "programaciones"
            : params.get("tab") === "propuestas" && proposals
              ? "propuestas"
              : "configuracion"
      }
      className="gap-6"
      onValueChange={(value) => {
        const url = new URL(window.location.href)
        url.searchParams.set("tab", String(value))
        window.history.replaceState(null, "", url)
      }}
    >
      <TabsBar aria-label="Secciones del agente">
        <TabsTrigger value="configuracion" className="flex-none px-4">
          Configuración
        </TabsTrigger>
        {proposals && (
          <TabsTrigger value="propuestas" className="flex-none px-4">
            Propuestas
          </TabsTrigger>
        )}
        {activation && (
          <TabsTrigger value="activacion" className="flex-none px-4">
            Activación
          </TabsTrigger>
        )}
        {schedules && (
          <TabsTrigger value="programaciones" className="flex-none px-4">
            Programaciones
          </TabsTrigger>
        )}
      </TabsBar>
      <TabsContent value="configuracion" keepMounted className="space-y-6">
        {configuration}
      </TabsContent>
      {proposals && (
        <TabsContent value="propuestas" keepMounted className="space-y-6">
          {proposals}
        </TabsContent>
      )}
      {activation && (
        <TabsContent value="activacion" className="space-y-6">
          {activation}
        </TabsContent>
      )}
      {schedules && (
        <TabsContent value="programaciones" className="space-y-6">
          {schedules}
        </TabsContent>
      )}
    </Tabs>
  )
}
