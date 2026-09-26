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
          "Accede cuando su despliegue esté aprobado y completado.",
        ],
      ]
    : [
        [
          "Revisar propuestas",
          "Versiones exactas enviadas con consentimiento del cliente.",
          "/submissions",
        ],
        [
          "Evaluar y desplegar",
          "Pruebas de la versión aprobada antes de activarla.",
        ],
        [
          "Supervisar la operación",
          "Salud, consumo y recuperación del agente.",
        ],
      ]
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tu flujo de trabajo</CardTitle>
        <CardDescription>
          La personalización y la revisión están disponibles. La ejecución del
          agente se habilitará en la siguiente etapa.
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
