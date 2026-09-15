import { AgentPageTabs } from "@workspace/ui/components/agent-page-tabs"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  PageHeaderSkeleton,
  RecordHeaderSkeleton,
  BackRowSkeleton,
  TableSkeleton,
  FiltersCardSkeleton,
} from "@workspace/ui/components/foundation-skeletons"
import { Card, CardHeader, CardContent } from "@workspace/ui/components/card"
export function AgentsSkeleton() {
  return (
    <>
      <PageHeaderSkeleton />
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-5 w-4/5" />
      <TableSkeleton columns={7} />
    </>
  )
}
export function AgentEditorSkeleton() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <BackRowSkeleton />
      <RecordHeaderSkeleton indicator="metadata" />
      <AgentPageTabs
        configuration={
          <>
            <div className="space-y-6">
              {["prompt", "skills", "knowledge", "tools", "connections"].map(
                (section) => (
                  <Card
                    key={section}
                    className="gap-5 py-6 [--card-spacing:--spacing(6)]"
                  >
                    <CardHeader className="gap-2">
                      <div className="flex items-center gap-2.5">
                        <Skeleton className="size-5 shrink-0" />
                        <Skeleton className="h-7 w-56" />
                      </div>
                      <Skeleton className="h-5 w-4/5" />
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {section === "prompt" ? (
                        <div className="space-y-3">
                          <Skeleton className="h-60 w-full" />
                          <Skeleton className="h-4 w-2/3" />
                        </div>
                      ) : section === "knowledge" ? (
                        <div className="space-y-3">
                          <Skeleton className="h-5 w-40" />
                          <div className="divide-y border-t">
                            {[0, 1, 2].map((row) => (
                              <div
                                key={row}
                                className="flex items-center gap-3 py-4"
                              >
                                <Skeleton className="size-4" />
                                <Skeleton className="h-5 w-2/3" />
                              </div>
                            ))}
                          </div>
                          <Skeleton className="h-4 w-3/4" />
                        </div>
                      ) : section === "tools" || section === "connections" ? (
                        <Skeleton className="h-5 w-4/5" />
                      ) : (
                        <div className="flex items-center gap-4 border-t py-5">
                          <div className="min-w-0 flex-1 space-y-3">
                            <Skeleton className="h-5 w-1/2" />
                            <Skeleton className="h-4 w-4/5" />
                          </div>
                          <Skeleton className="size-8" />
                        </div>
                      )}
                    </CardContent>
                    {section !== "tools" && section !== "connections" && (
                      <div className="border-t px-6 pt-4">
                        <Skeleton className="h-5 w-3/4" />
                      </div>
                    )}
                  </Card>
                )
              )}
              <div className="flex justify-between gap-4 rounded-lg border p-4">
                <div className="space-y-2">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-4 w-64" />
                </div>
                <Skeleton className="h-9 w-36" />
              </div>
            </div>
            <div className="grid items-stretch gap-6 lg:grid-cols-2">
              {["new", "current"].map((kind) => (
                <Card
                  key={kind}
                  className="gap-5 py-6 [--card-spacing:--spacing(6)]"
                >
                  <CardHeader className="gap-2">
                    <Skeleton className="h-7 w-44" />
                    <Skeleton className="h-5 w-4/5" />
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col gap-5">
                    <div className="overflow-hidden rounded-lg border bg-muted/20">
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
                        <div className="flex items-center gap-3">
                          <Skeleton className="size-5 shrink-0" />
                          <div className="space-y-1">
                            <Skeleton className="h-5 w-20" />
                            <Skeleton className="h-4 w-24" />
                          </div>
                        </div>
                        <Skeleton className="h-5 w-24" />
                      </div>
                      <div className="space-y-2 p-4">
                        {kind === "current" && (
                          <Skeleton className="h-4 w-44" />
                        )}
                        <Skeleton className="h-4 w-full" />
                        {kind === "new" && (
                          <>
                            <Skeleton className="h-4 w-full" />
                            <Skeleton className="h-4 w-3/4" />
                          </>
                        )}
                      </div>
                    </div>
                    <div className="mt-auto space-y-3 border-t pt-5">
                      <div className="flex flex-wrap gap-3">
                        <Skeleton className="h-9 w-36" />
                        {kind === "current" && (
                          <Skeleton className="h-9 w-36" />
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        }
        proposals={
          <>
            <Card className="gap-5 py-6 [--card-spacing:--spacing(6)]">
              <CardHeader className="gap-2">
                <Skeleton className="h-7 w-60" />
                <Skeleton className="h-5 w-4/5" />
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto border-t">
                  <div className="min-w-[700px]">
                    <div className="grid grid-cols-[32px_repeat(4,minmax(0,1fr))] gap-4 border-b px-2 py-3">
                      <span />
                      <Skeleton className="h-4 w-20" />
                      <Skeleton className="h-4 w-16" />
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-4 w-24" />
                    </div>
                    {[0, 1].map((row) => (
                      <div
                        key={row}
                        className="grid grid-cols-[32px_repeat(4,minmax(0,1fr))] items-start gap-4 border-b px-2 py-4 last:border-0"
                      >
                        <Skeleton className="size-8" />
                        <Skeleton className="h-4 w-20" />
                        <Skeleton className="h-5 w-24 rounded-full" />
                        <Skeleton className="h-4 w-4/5" />
                        <Skeleton className="h-5 w-24" />
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        }
      />
    </div>
  )
}
export function KnowledgeSkeleton() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <PageHeaderSkeleton />
      <Skeleton className="h-8 w-48" />
      {["collections", "upload", "documents", "search"].map((section) => (
        <Card
          key={section}
          className="gap-5 py-6 [--card-spacing:--spacing(6)]"
        >
          <CardHeader className="gap-2">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-5 w-4/5" />
          </CardHeader>
          <CardContent>
            {section === "upload" || section === "search" ? (
              <div className="grid gap-5 sm:grid-cols-2">
                {[0, 1].map((field) => (
                  <div key={field} className="space-y-2">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-9 w-full" />
                    {field === 1 && <Skeleton className="h-4 w-4/5" />}
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-4">
                <Skeleton className="h-9 w-full max-w-sm" />
                <div className="divide-y border-t">
                  <div className="flex justify-between gap-4 py-3">
                    {Array.from({ length: 4 }, (_, column) => (
                      <Skeleton key={column} className="h-4 w-20" />
                    ))}
                  </div>
                  {[0, 1, 2].map((row) => (
                    <div key={row} className="flex items-center gap-4 py-4">
                      <Skeleton className="size-5 shrink-0" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-5 w-4/5" />
                        {section === "documents" && (
                          <Skeleton className="h-4 w-20" />
                        )}
                      </div>
                      <Skeleton className="h-5 w-20" />
                      <Skeleton className="h-5 w-20" />
                      {section === "collections" && (
                        <Skeleton className="size-8" />
                      )}
                      {section === "documents" && (
                        <div className="flex gap-1">
                          <Skeleton className="size-8" />
                          <Skeleton className="size-8" />
                          <Skeleton className="size-8" />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap justify-between gap-3">
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-8 w-64 max-w-full" />
                </div>
              </div>
            )}
            {section === "search" && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
                <Skeleton className="h-5 w-56" />
                <Skeleton className="h-9 w-40" />
              </div>
            )}
          </CardContent>
          <div className="-mb-6 flex flex-wrap items-center justify-between gap-3 border-t bg-muted/30 px-6 py-4">
            <Skeleton className="h-5 w-1/2" />
            {section !== "documents" && section !== "search" && (
              <Skeleton className="h-9 w-36" />
            )}
          </div>
        </Card>
      ))}
    </div>
  )
}
export function ReviewsSkeleton() {
  return (
    <>
      <PageHeaderSkeleton />
      <FiltersCardSkeleton />
      <div className="flex gap-3 overflow-hidden" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-28 shrink-0" />
        ))}
      </div>
      <TableSkeleton columns={6} />
    </>
  )
}
export function ReviewDetailSkeleton() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <BackRowSkeleton />
      <RecordHeaderSkeleton indicator="status" />
      <Skeleton className="h-5 w-4/5" />
      {["prompt", "skills", "knowledge"].map((section) => (
        <Card
          key={section}
          className="gap-5 py-6 [--card-spacing:--spacing(6)]"
        >
          <CardHeader className="gap-2">
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-5 shrink-0" />
              <Skeleton className="h-7 w-56 max-w-full" />
            </div>
            <Skeleton className="h-5 w-4/5" />
          </CardHeader>
          <CardContent className="space-y-3">
            {section === "prompt" ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <>
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-4 w-4/5" />
              </>
            )}
          </CardContent>
          {section === "knowledge" && (
            <div className="-mb-6 border-t bg-muted/30 px-6 py-4">
              <Skeleton className="h-5 w-3/4" />
            </div>
          )}
        </Card>
      ))}
      <EvaluationSkeleton />
      <Card className="gap-5 py-6 [--card-spacing:--spacing(6)]">
        <CardHeader className="gap-2">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-5 shrink-0" />
            <Skeleton className="h-7 w-48" />
          </div>
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent className="space-y-5">
          <Skeleton className="h-5 w-4/5" />
          <div className="space-y-4 border-t pt-5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-9 w-full sm:max-w-sm" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-7 w-36" />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function EvaluationSkeleton({ customer = false }: { customer?: boolean }) {
  return (
    <Card className="gap-5 py-6 [--card-spacing:--spacing(6)]">
      <CardHeader className="gap-2">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-5 shrink-0" />
          <Skeleton className="h-7 w-48" />
        </div>
        <Skeleton className="h-5 w-4/5" />
      </CardHeader>
      <CardContent className="space-y-5">
        {customer ? (
          <>
            <Skeleton className="h-5 w-72 max-w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-9 w-48" />
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function ReviewReceiptSkeleton() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <BackRowSkeleton />
      <RecordHeaderSkeleton indicator="status" />
      {[
        "summary",
        "prompt",
        "skills",
        "knowledge",
        "criteria",
        "results",
        "approval",
      ].map((section) => (
        <Card
          key={section}
          className="gap-5 py-6 [--card-spacing:--spacing(6)]"
        >
          <CardHeader className="gap-2">
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-5" />
              <Skeleton className="h-7 w-56 max-w-full" />
            </div>
            <Skeleton className="h-5 w-4/5" />
          </CardHeader>
          <CardContent className="space-y-4">
            {section === "summary" || section === "approval" ? (
              <div className="grid gap-5 sm:grid-cols-2">
                {Array.from(
                  { length: section === "summary" ? 6 : 4 },
                  (_, i) => (
                    <div key={i} className="space-y-2">
                      <Skeleton className="h-4 w-28" />
                      <Skeleton className="h-5 w-40" />
                    </div>
                  )
                )}
              </div>
            ) : section === "prompt" ? (
              <Skeleton className="h-40 w-full" />
            ) : section === "criteria" || section === "results" ? (
              <div className="divide-y border-y">
                {[0, 1, 2].map((row) => (
                  <div
                    key={row}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_12rem_auto]"
                  >
                    <Skeleton className="h-5 w-4/5" />
                    <div className="col-start-1 row-start-2 flex items-center gap-2 sm:col-start-2 sm:row-start-1">
                      <Skeleton className="size-3.5 shrink-0" />
                      <Skeleton className="h-4 w-28" />
                    </div>
                    <Skeleton className="col-start-2 row-start-1 size-4 sm:col-start-3" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-3/4" />
              </>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
