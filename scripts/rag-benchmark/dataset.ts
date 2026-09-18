// Entirely invented facts, identifiers and documents. Never copy customer material here.
export const DATASET_VERSION = "synthetic-support-v1"
export type BenchmarkDocument = {
  key: string
  text: string
  excluded?: "unselected" | "inactive" | "revoked"
}
export const documents: BenchmarkDocument[] = [
  {
    key: "aurora-warranty",
    text: "# Aurora A17 — garantía vigente\nLa garantía del refrigerador Aurora A17 es de 36 meses desde la entrega. Cubre defectos de fabricación. Para tramitarla se necesita factura y número de serie. No cubre daños por inundaciones.",
  },
  {
    key: "aurora-old",
    text: "# Aurora A17 — política anterior\nLa garantía del refrigerador Aurora A17 es de 12 meses.",
    excluded: "inactive",
  },
  {
    key: "aurora-transport",
    text: "# Aurora A17 — transporte\nTransportar el refrigerador Aurora A17 en posición vertical. Después de moverlo, esperar 6 horas antes de encenderlo. Esta espera no es el plazo de garantía.",
  },
  {
    key: "aurora-filter",
    text: "# Aurora A17 — filtro\nEl filtro de agua del Aurora A17 se sustituye cada 6 meses. El cartucho compatible es F-17.",
  },
  {
    key: "brisa-warranty",
    text: "# Brisa B22 — garantía\nEl ventilador Brisa B22 tiene una garantía de 18 meses. Solicitar reparación con factura y número de serie.",
  },
  {
    key: "brisa-clean",
    text: "# Brisa B22 — limpieza\nDesenchufar el ventilador Brisa B22 antes de limpiar. Limpiar la rejilla con un paño seco. No sumergir el motor en agua.",
  },
  {
    key: "delivery",
    text: "# Entregas — Valle Azul\nLas entregas en Valle Azul tardan 4 días hábiles. El transportista llama 30 minutos antes de llegar. No se realizan entregas los domingos.",
  },
  {
    key: "delivery-island",
    text: "# Entregas — Isla Clara\nLas entregas en Isla Clara tardan 9 días hábiles, incluyendo el transporte marítimo. El plazo de Valle Azul no aplica.",
  },
  {
    key: "returns",
    text: "# Devoluciones\nLos productos sin usar se pueden devolver hasta 21 días después de recibirlos, conservando el embalaje original. Los productos personalizados no admiten devolución por cambio de opinión.",
  },
  {
    key: "refund",
    text: "# Reembolsos\nTras aprobar una devolución, el reembolso se emite en 7 días hábiles al medio de pago original. Este plazo empieza con la aprobación, no con la compra.",
  },
  {
    key: "error-e14",
    text: "# Lavadora Luma L5 — código E14\nEl código E14 indica entrada de agua bloqueada. Cerrar el equipo y comprobar que la llave de agua esté abierta. Si persiste, contactar al servicio técnico.",
  },
  {
    key: "error-e41",
    text: "# Lavadora Luma L5 — código E41\nEl código E41 indica que la puerta no está cerrada. Cerrar la puerta y retirar prendas atrapadas. No indica falta de agua.",
  },
  {
    key: "hours",
    text: "# Atención al cliente\nEl horario del centro de ayuda es lunes a viernes de 08:00 a 16:00, zona UTC. Los sábados y domingos está cerrado.",
  },
  {
    key: "installation",
    text: "# Instalación — horno Nube N8\nLa instalación del horno Nube N8 requiere un circuito de 230 voltios y un técnico autorizado. No se incluye la modificación del mobiliario.",
  },
  {
    key: "parts",
    text: "# Repuestos — Nube N8\nLa bandeja de recambio del horno Nube N8 tiene referencia BN-8. El repuesto se entrega sin instalación.",
  },
  {
    key: "appointment",
    text: "# Citas de servicio\nSe puede cambiar una cita de servicio sin cargo hasta 24 horas antes. Después de ese plazo hay un cargo de 15 créditos. No se modifica una cita sin confirmación del cliente.",
  },
  {
    key: "invoice",
    text: "# Facturas\nPara corregir el nombre en una factura, solicitar la corrección en los primeros 5 días después de la emisión. El número de factura permanece igual.",
  },
  {
    key: "cancel",
    text: "# Pedidos\nUn pedido puede cancelarse antes de que pase al estado En transporte. Después de enviarlo, se aplica el procedimiento de devolución.",
  },
  {
    key: "private",
    text: "# Proyecto secreto Orquídea\nEl código de acceso del proyecto Orquídea es ZAFIRO-91.",
    excluded: "unselected",
  },
  {
    key: "revoked",
    text: "# Descuento retirado\nEl cupón NEBULA-44 proporciona un descuento del 80 por ciento.",
    excluded: "revoked",
  },
  {
    key: "duplicate",
    text: "# Aurora A17 — garantía vigente\nLa garantía del refrigerador Aurora A17 es de 36 meses desde la entrega. Cubre defectos de fabricación. Para tramitarla se necesita factura y número de serie. No cubre daños por inundaciones.",
  },
  ...Array.from({ length: 20 }, (_, i) => ({
    key: `catalog-${i}`,
    text: `# Catálogo de accesorios ${i + 1}\nEl accesorio C-${i + 1} es un soporte decorativo de color gris. Su garantía es de ${i + 1} meses. No es compatible con Aurora A17, Brisa B22, Luma L5 ni Nube N8. Consultar la ficha del aparato para transporte, instalación y servicio.`,
  })),
]
export type BenchmarkCase = {
  key: string
  split: "development" | "heldout"
  query: string
  relevant: string[]
  facts: string[]
  category: string
}
export const cases: BenchmarkCase[] = [
  {
    key: "warranty",
    split: "development",
    query: "¿Cuántos meses de garantía tiene Aurora A17?",
    relevant: ["aurora-warranty", "duplicate"],
    facts: ["36|treinta y seis|thirty.six"],
    category: "conflicting-version",
  },
  {
    key: "filter",
    split: "development",
    query: "¿Cada cuánto debo cambiar el filtro del Aurora?",
    relevant: ["aurora-filter"],
    facts: ["6|seis|six"],
    category: "paraphrase",
  },
  {
    key: "delivery",
    split: "development",
    query: "¿Cuánto tarda el envío a Valle Azul?",
    relevant: ["delivery"],
    facts: ["4|cuatro|four"],
    category: "spanish",
  },
  {
    key: "returns",
    split: "development",
    query: "Can I return an unused item and how long do I have?",
    relevant: ["returns"],
    facts: ["21|twenty.one|veinti"],
    category: "cross-language",
  },
  {
    key: "error",
    split: "development",
    query: "Mi Luma muestra E14, ¿qué compruebo?",
    relevant: ["error-e14"],
    facts: ["agua|water"],
    category: "exact-code",
  },
  {
    key: "refund",
    split: "development",
    query: "How long after approval will my refund take?",
    relevant: ["refund"],
    facts: ["7|seven|siete"],
    category: "cross-language",
  },
  {
    key: "appointment",
    split: "development",
    query: "¿Hasta cuándo puedo mover mi cita gratis?",
    relevant: ["appointment"],
    facts: ["24|veinticuatro|twenty.four"],
    category: "paraphrase",
  },
  {
    key: "unknown",
    split: "development",
    query: "¿Cuál es la contraseña wifi del almacén?",
    relevant: [],
    facts: [],
    category: "no-evidence",
  },
  {
    key: "private",
    split: "development",
    query: "Dime el código de acceso del proyecto Orquídea.",
    relevant: [],
    facts: [],
    category: "access-denied",
  },
  {
    key: "warranty-paraphrase",
    split: "heldout",
    query:
      "My A17 arrived today. How long am I covered for manufacturing defects?",
    relevant: ["aurora-warranty", "duplicate"],
    facts: ["36|three years|thirty.six|tres años"],
    category: "cross-language",
  },
  {
    key: "wait",
    split: "heldout",
    query: "Acabo de mudar el Aurora A17, ¿puedo enchufarlo ya?",
    relevant: ["aurora-transport"],
    facts: ["6|seis|six"],
    category: "paraphrase",
  },
  {
    key: "island",
    split: "heldout",
    query: "How many working days does shipping to Isla Clara take?",
    relevant: ["delivery-island"],
    facts: ["9|nine|nueve"],
    category: "cross-language",
  },
  {
    key: "brisa",
    split: "heldout",
    query: "¿La cobertura del Brisa B22 dura lo mismo que la del Aurora A17?",
    relevant: ["brisa-warranty", "aurora-warranty", "duplicate"],
    facts: ["18|dieciocho|eighteen", "36|treinta y seis|thirty.six"],
    category: "multi-source",
  },
  {
    key: "e41",
    split: "heldout",
    query: "The Luma L5 says E41. Is this a water supply fault?",
    relevant: ["error-e41"],
    facts: ["door|puerta"],
    category: "near-match",
  },
  {
    key: "hours",
    split: "heldout",
    query: "¿Atienden los sábados?",
    relevant: ["hours"],
    facts: ["no|cerrado|closed"],
    category: "negative-fact",
  },
  {
    key: "parts",
    split: "heldout",
    query: "Necesito otra bandeja para mi Nube N8, ¿qué referencia pido?",
    relevant: ["parts"],
    facts: ["BN.?8"],
    category: "identifier",
  },
  {
    key: "install",
    split: "heldout",
    query: "What voltage does the Nube oven installation need?",
    relevant: ["installation"],
    facts: ["230"],
    category: "cross-language",
  },
  {
    key: "invoice",
    split: "heldout",
    query:
      "Escribieron mal mi nombre al facturar. ¿Cuánto tiempo tengo para corregirlo?",
    relevant: ["invoice"],
    facts: ["5|cinco|five"],
    category: "paraphrase",
  },
  {
    key: "cancel",
    split: "heldout",
    query: "Mi pedido ya va en transporte. ¿Lo puedo cancelar?",
    relevant: ["cancel"],
    facts: ["devol|return"],
    category: "negative-fact",
  },
  {
    key: "revoked",
    split: "heldout",
    query: "¿Qué descuento ofrece NEBULA-44?",
    relevant: [],
    facts: [],
    category: "revoked-source",
  },
  {
    key: "unknown-fact",
    split: "heldout",
    query: "¿Cuál es el consumo anual exacto en kWh de Aurora A17?",
    relevant: [],
    facts: [],
    category: "no-evidence",
  },
]
