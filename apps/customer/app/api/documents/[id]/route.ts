import { downloadDocument } from "@agentonic/server/documents"
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    return await downloadDocument(request, (await params).id)
  } catch {
    return Response.json(
      { ok: false },
      { status: 401, headers: { "Cache-Control": "private, no-store" } }
    )
  }
}
