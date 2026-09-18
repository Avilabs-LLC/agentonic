import { finishGmail } from "@agentonic/server/gmail"
export async function GET(request: Request) {
  try {
    return new Response(null, {
      status: 303,
      headers: {
        Location: (await finishGmail(new URL(request.url))).toString(),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    })
  } catch {
    return new Response(
      "No se pudo conectar Gmail. Regresa al agente para volver a intentarlo; revisa que tu cuenta esté autorizada como usuario de prueba en Google.",
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
