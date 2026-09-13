import { requireIdentity } from "@agentonic/server/auth"
import { PageHeader } from "@workspace/ui/components/page-header"
import { AccessPending } from "@workspace/ui/components/access-pending"
import { FoundationRoadmap } from "@workspace/ui/components/foundation-roadmap"
import { home } from "@/lib/navigation"
import { WorkspaceTable } from "@workspace/ui/components/workspace-table"
export default async function Page() {
  const identity = await requireIdentity("customer")
  return (
    <>
      <PageHeader
        title={home.title}
        description={home.description}
        count={identity.hasAccess ? identity.workspaces.length : undefined}
      />
      {identity.hasAccess ? (
        <>
          <WorkspaceTable workspaces={identity.workspaces} />
          <FoundationRoadmap customer={true} />
        </>
      ) : (
        <AccessPending admin={false} />
      )}
    </>
  )
}
