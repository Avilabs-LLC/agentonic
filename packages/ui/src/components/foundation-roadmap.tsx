import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@workspace/ui/components/card"
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemSeparator,
  ItemActions,
} from "@workspace/ui/components/item"
import Link from "next/link"
import { ChevronRightIcon } from "lucide-react"
export function FoundationRoadmap({ customer }: { customer: boolean }) {
  const steps = customer
    ? [
        [
          "Personaliza tu agente",
          "Instrucciones, habilidades escritas y documentos privados.",
          "/agents",
        ],
        [
          "Envía a revisión",
          "Congela una versión y recibe comentarios del equipo.",
          "/agents",
        ],
        [
          "Usa tu agente",
          "Chatea en privado con la versión aprobada que actives.",
          "/chats",
        ],
      ]
    : [
        [
          "Revisar propuestas",
          "Versiones exactas enviadas con consentimiento del cliente.",
          "/submissions",
        ],
        [
          "Evaluar y activar",
          "Evaluaciones de la versión exacta y activación en pruebas privadas.",
          "/expirations",
        ],
        [
          "Supervisar la operación",
          "Agentes, despliegues, actividad y costos.",
          "/activity",
        ],
      ]
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tu flujo de trabajo</CardTitle>
        <CardDescription>
          {customer
            ? "Personaliza, envía a revisión y usa tu agente en pruebas privadas. El uso con más personas llegará en la etapa piloto."
            : "Revisión, evaluación, activación en pruebas privadas y supervisión. La operación con clientes reales llegará en la etapa piloto."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {steps.map(([title, description, href], i) => (
          <div key={title}>
            {i > 0 && <ItemSeparator />}
            <Item>
              <ItemContent>
                <ItemTitle>
                  {href ? (
                    <Link href={href} className="hover:underline">
                      {title}
                    </Link>
                  ) : (
                    title
                  )}
                </ItemTitle>
                <ItemDescription>{description}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <span className="text-xs text-muted-foreground">
                  {href ? (
                    <ChevronRightIcon aria-hidden="true" className="size-4" />
                  ) : (
                    "Pronto"
                  )}
                </span>
              </ItemActions>
            </Item>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
