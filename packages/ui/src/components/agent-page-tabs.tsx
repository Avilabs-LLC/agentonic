"use client"
import type { ReactNode } from "react"
import { useSearchParams } from "next/navigation"
import {
  Tabs,
  TabsList,
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
  proposals: ReactNode
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
            : params.get("tab") === "propuestas"
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
      <TabsList variant="line" className="w-full justify-start border-b">
        <TabsTrigger value="configuracion" className="flex-none px-4">
          Configuración
        </TabsTrigger>
        <TabsTrigger value="propuestas" className="flex-none px-4">
          Propuestas
        </TabsTrigger>
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
      </TabsList>
      <TabsContent value="configuracion" keepMounted className="space-y-6">
        {configuration}
      </TabsContent>
      <TabsContent value="propuestas" keepMounted className="space-y-6">
        {proposals}
      </TabsContent>
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
