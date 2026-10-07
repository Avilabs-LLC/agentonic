import type { ReactNode } from "react"
import { environmentLabels } from "@agentonic/contracts/lifecycle"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@workspace/ui/components/item"

// Servers and evaluators grouped by place, side by side, the VM first: every
// row stays visible, since a lapsed one stops work there (Vencimientos,
// Despliegues).
const places = ["azure_staging", "local"] as const
export type PlaceItem = {
  environment: (typeof places)[number]
  name: string
  description: ReactNode
  action: ReactNode
}
export function PlaceGroups({ items }: { items: PlaceItem[] }) {
  const groups = places
    .map((environment) => ({
      environment,
      items: items.filter((item) => item.environment === environment),
    }))
    .filter((group) => group.items.length > 0)
  return (
    <div className="grid gap-6 md:grid-cols-2">
      {groups.map((group) => (
        <section
          key={group.environment}
          aria-labelledby={`place-${group.environment}`}
          className="space-y-1"
        >
          <h3
            id={`place-${group.environment}`}
            className="text-xs font-medium text-muted-foreground"
          >
            {environmentLabels[group.environment]}
          </h3>
          <ItemGroup>
            {group.items.map((item, index) => (
              <div key={item.name}>
                {index > 0 && <ItemSeparator className="my-0" />}
                <Item size="sm" className="px-0">
                  <ItemContent>
                    <ItemTitle>{item.name}</ItemTitle>
                    <ItemDescription className="line-clamp-none whitespace-normal">
                      {item.description}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>{item.action}</ItemActions>
                </Item>
              </div>
            ))}
          </ItemGroup>
        </section>
      ))}
    </div>
  )
}
