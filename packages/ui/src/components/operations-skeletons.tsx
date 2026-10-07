import { Skeleton } from "@workspace/ui/components/skeleton"
import { Card, CardContent, CardHeader } from "@workspace/ui/components/card"
import {
  BackRowSkeleton,
  PageHeaderSkeleton,
  RecordHeaderSkeleton,
  TableSkeleton,
} from "@workspace/ui/components/foundation-skeletons"

// Loading states for the Admin operations screens (architecture §52), matching
// each page: header, then its cards and tables in order.
function ListCardSkeleton({ items }: { items: number }) {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </CardHeader>
      <CardContent className="divide-y">
        {Array.from({ length: items }, (_, i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-4 py-5 first:pt-2.5 last:pb-2.5"
          >
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-4 w-80 max-w-full" />
            </div>
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
/** A card of servers grouped by place: two groups of two rows, side by side. */
function PlaceGroupsCardSkeleton() {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        {[1, 2].map((group) => (
          <div key={group} className="space-y-1">
            <Skeleton className="h-3 w-32" />
            <div className="divide-y">
              {[1, 2].map((i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-4 py-4"
                >
                  <div className="space-y-1.5">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-4 w-64 max-w-full" />
                  </div>
                  <Skeleton className="h-5 w-20 rounded-full" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
function StatsSkeleton({ count }: { count: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i}>
          <CardHeader className="space-y-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-7 w-12" />
          </CardHeader>
        </Card>
      ))}
    </div>
  )
}
function Loading({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div aria-label={label} role="status" className="space-y-6">
      <PageHeaderSkeleton />
      {children}
    </div>
  )
}
/** Agentes: the twelve-column agents table. */
export function OperationsAgentsSkeleton() {
  return (
    <Loading label="Cargando agentes">
      <TableSkeleton columns={12} />
    </Loading>
  )
}
/** One agent: back row, header, three tiles, tabs and the proposals table. */
export function OperationsAgentSkeleton() {
  return (
    <div aria-label="Cargando agente" role="status" className="space-y-6">
      <div className="space-y-3">
        <BackRowSkeleton />
        <RecordHeaderSkeleton />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-3 w-32" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-5 w-28 rounded-full" />
              <Skeleton className="h-3 w-40" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="flex gap-6 border-b pb-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-5 w-24" />
        ))}
      </div>
      <TableSkeleton columns={6} />
    </div>
  )
}
/** Actividad: five stat tiles and the seven-column changes table. */
export function OperationsActivitySkeleton() {
  return (
    <Loading label="Cargando actividad">
      <StatsSkeleton count={5} />
      <TableSkeleton columns={7} />
    </Loading>
  )
}
/** Espacios de trabajo: the eight-column workspaces table and the staff card. */
export function OperationsWorkspacesSkeleton() {
  return (
    <Loading label="Cargando espacios de trabajo">
      <TableSkeleton columns={8} />
      <ListCardSkeleton items={2} />
    </Loading>
  )
}
/** Despliegues: the installations card (four registrations) and the ten-column table. */
export function OperationsDeploymentsSkeleton() {
  return (
    <Loading label="Cargando despliegues">
      <PlaceGroupsCardSkeleton />
      <TableSkeleton columns={10} />
    </Loading>
  )
}
/** Costos: the provider card, the five-column daily table and the agents card. */
export function OperationsCostsSkeleton() {
  return (
    <Loading label="Cargando costos">
      <ListCardSkeleton items={3} />
      <TableSkeleton columns={5} />
      <ListCardSkeleton items={3} />
    </Loading>
  )
}
/** Runtime: the seven-column releases table. */
export function OperationsReleasesSkeleton() {
  return (
    <Loading label="Cargando versiones del runtime">
      <TableSkeleton columns={7} />
    </Loading>
  )
}
