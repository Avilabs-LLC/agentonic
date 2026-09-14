import { handleDocumentUpload } from "@agentonic/server/documents"
export async function POST(request: Request) {
  return handleDocumentUpload(request)
}
