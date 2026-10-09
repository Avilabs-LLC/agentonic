import { finishGmail } from "@agentonic/server/gmail"
import { finishDrive, isDriveCallback } from "@agentonic/server/drive"
// One registered callback serves Gmail and Drive: the browser's sealed cookie
// says which connection this state belongs to.
export async function GET(request: Request) {
  const url = new URL(request.url)
  const drive = await isDriveCallback(url).catch(() => false)
  try {
    return new Response(null, {
      status: 303,
      headers: {
        Location: (drive
          ? await finishDrive(url)
          : await finishGmail(url)
        ).toString(),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    })
  } catch {
    return new Response(
      drive
        ? "No se pudo conectar Google Drive. Regresa a Agentonic para volver a intentarlo; revisa que tu cuenta esté autorizada como usuario de prueba en Google."
        : "No se pudo completar la conexión con Google. Regresa a Agentonic para volver a intentarlo; revisa que tu cuenta esté autorizada como usuario de prueba en Google.",
      {
        status: 400,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      }
    )
  }
}
