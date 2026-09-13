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
import { Badge } from "@workspace/ui/components/badge"
export function FoundationRoadmap({ customer }: { customer: boolean }) {
  const steps = customer
    ? [
        [
          "Personaliza tu agente",
          "Instrucciones, documentos y conexiones seleccionadas.",
        ],
        [
          "Prueba y envía a revisión",
          "Una versión concreta para que nuestro equipo la revise.",
        ],
        [
          "Usa tu agente",
          "Accede cuando su despliegue esté aprobado y completado.",
        ],
      ]
    : [
        [
          "Revisar propuestas",
          "Versiones de agentes y permisos solicitados por cada cliente.",
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
        <CardTitle>Próximas funciones</CardTitle>
        <CardDescription>
          La base de acceso está disponible. Estas funciones aún están en
          desarrollo.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {steps.map(([title, description], i) => (
          <div key={title}>
            {i > 0 && <ItemSeparator />}
            <Item>
              <ItemContent>
                <ItemTitle>{title}</ItemTitle>
                <ItemDescription>{description}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Badge variant="outline" className="rounded-full">
                  Pronto
                </Badge>
              </ItemActions>
            </Item>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
