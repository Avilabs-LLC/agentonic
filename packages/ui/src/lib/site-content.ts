// The public site (architecture §85): the homepage, the privacy policy and the
// terms, in Spanish and in English, on agentonic.avilabs.tech. Google's OAuth
// reviewers read them, so every statement here describes what the platform
// does today; change the text when the product changes.
export type Locale = "es" | "en"
export type SiteSection = {
  heading: string
  paragraphs?: string[]
  bullets?: string[]
  after?: string[]
}
export type SiteDocument = {
  title: string
  /** The date the text took effect, as shown. */
  updated: string
  intro: string[]
  sections: SiteSection[]
}
export { SITE_HOSTNAME } from "@agentonic/contracts/site"
/** The customer app, where "Iniciar sesión" leads. */
export const APP_URL = "https://app.agentonic.avilabs.tech"
export const CONTACT_EMAIL = "leonardo@avilabs.tech"
export const OPERATOR = "Avilabs LLC"
export const sitePaths: Record<
  Locale,
  { home: string; privacy: string; terms: string }
> = {
  es: { home: "/sitio", privacy: "/privacidad", terms: "/terminos" },
  en: { home: "/sitio/en", privacy: "/privacidad/en", terms: "/terminos/en" },
}
export const GOOGLE_USER_DATA_POLICY =
  "https://developers.google.com/terms/api-services-user-data-policy"
/** Google's required Limited Use statement, on the homepage and in the policy. */
export const LIMITED_USE_STATEMENT: Record<Locale, string> = {
  en: "Agentonic's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.",
  es: "El uso que Agentonic hace de la información recibida de las API de Google, y su transferencia a cualquier otra aplicación, se ajusta a la Política de datos de usuario de los servicios de API de Google (Google API Services User Data Policy), incluidos los requisitos de uso limitado (Limited Use).",
}
export const siteLabels: Record<
  Locale,
  {
    brand: string
    tagline: string
    signIn: string
    privacy: string
    terms: string
    home: string
    otherLanguage: string
    otherLanguageLabel: string
    updated: string
    policyLink: string
    operator: string
  }
> = {
  es: {
    brand: "Agentonic",
    tagline: "Agentes de IA para tu equipo, con tus cuentas y bajo tu control.",
    signIn: "Iniciar sesión",
    privacy: "Política de privacidad",
    terms: "Términos del servicio",
    home: "Inicio",
    otherLanguage: "English",
    otherLanguageLabel: "Read in English",
    updated: "Vigente desde el",
    policyLink:
      "Política de datos de usuario de los servicios de API de Google",
    operator: `Un producto de ${OPERATOR}`,
  },
  en: {
    brand: "Agentonic",
    tagline:
      "AI agents for your team, on your own accounts and under your control.",
    signIn: "Sign in",
    privacy: "Privacy policy",
    terms: "Terms of service",
    home: "Home",
    otherLanguage: "Español",
    otherLanguageLabel: "Leer en español",
    updated: "Effective",
    policyLink: "Google API Services User Data Policy",
    operator: `A product of ${OPERATOR}`,
  },
}
export const siteHome: Record<
  Locale,
  {
    title: string
    lead: string
    sections: SiteSection[]
    limitedUseHeading: string
  }
> = {
  es: {
    title: "Agentes de IA que trabajan con tu correo y tus documentos",
    lead: "Agentonic es una plataforma donde una empresa configura asistentes de IA (agentes), les da instrucciones y conocimiento propio, y los conecta a cuentas como Gmail y Google Drive. Cada agente se prueba, se evalúa y se aprueba antes de operar, y cada acción que cambia algo en una cuenta se confirma antes de ejecutarse.",
    sections: [
      {
        heading: "Qué hace",
        bullets: [
          "Agentes configurados por tu equipo: instrucciones, habilidades y documentos privados que el agente usa para responder con citas.",
          "Conversaciones privadas: cada miembro habla con el agente en sus propias conversaciones; nadie más las lee.",
          "Versiones evaluadas: una versión se prueba y se califica con criterios acordados antes de aprobarse y activarse.",
          "Presupuestos claros: cada despliegue tiene un presupuesto por periodo y cada respuesta muestra lo que costó.",
        ],
      },
      {
        heading: "Cómo usa Agentonic tu cuenta de Google",
        paragraphs: [
          "Conectar una cuenta de Google no concede ninguna acción por sí misma. El titular de la cuenta elige, agente por agente, qué puede hacer el agente con su correo o sus archivos, y solo sus propias conversaciones con ese agente pueden usarlos.",
        ],
        bullets: [
          "Gmail (permiso gmail.modify): cuando se lo pides, el agente busca y lee correos e hilos para responderte; escribe respuestas y correos nuevos como borradores o listos para enviar; y propone etiquetas para grupos de correos. Cada borrador, envío o etiqueta se muestra con su contenido exacto y se ejecuta solo después de que lo confirmes, salvo un envío o borrador que tú mismo autorices por adelantado en una tarea programada (como máximo uno por ejecución, cancelable). Agentonic nunca archiva, mueve a la papelera ni elimina correos.",
          "Google Drive (permiso drive.file): el agente solo ve los archivos que seleccionas con el selector de Google y los documentos que él mismo crea. Puede leerlos para responder y proponer crear o actualizar un documento de Google Docs, siempre con tu confirmación.",
          "Aprender mi estilo (opcional, con consentimiento aparte): el agente puede analizar tus propios correos enviados de los últimos 90 días para redactar una guía de estilo que tú revisas y aceptas. Los correos se analizan y no se guardan.",
        ],
        after: [
          "El contenido de tu correo y tus archivos se envía únicamente al proveedor de IA que genera la respuesta que pediste, nunca se usa para entrenar modelos, no se vende y no se usa para publicidad. Los detalles están en la política de privacidad.",
        ],
      },
    ],
    limitedUseHeading: "Uso limitado de los datos de Google",
  },
  en: {
    title: "AI agents that work with your mail and your documents",
    lead: "Agentonic is a platform where a business configures AI assistants (agents), gives them instructions and its own knowledge, and connects them to accounts such as Gmail and Google Drive. Every agent is tested, evaluated and approved before it operates, and every action that changes something in an account is confirmed before it runs.",
    sections: [
      {
        heading: "What it does",
        bullets: [
          "Agents configured by your team: instructions, skills and private documents the agent uses to answer with citations.",
          "Private conversations: each member talks to the agent in their own conversations; nobody else reads them.",
          "Evaluated versions: a version is tested and graded against agreed criteria before it is approved and activated.",
          "Clear budgets: each deployment has a budget per period, and each answer shows what it cost.",
        ],
      },
      {
        heading: "How Agentonic uses your Google account",
        paragraphs: [
          "Connecting a Google account grants no action by itself. The account holder chooses, per agent, what the agent may do with their mail or files, and only their own conversations with that agent can use them.",
        ],
        bullets: [
          "Gmail (gmail.modify scope): when you ask, the agent searches and reads messages and threads to answer you; it writes replies and new messages as drafts or ready to send; and it proposes labels for groups of messages. Every draft, send or label is shown with its exact content and runs only after you confirm it, except a send or draft you yourself pre-authorize in a scheduled task (at most one per run, cancellable). Agentonic never archives, trashes or deletes mail.",
          "Google Drive (drive.file scope): the agent only sees the files you select with Google's picker and the documents it creates itself. It can read them to answer and propose creating or updating a Google Docs document, always with your confirmation.",
          "Learn my style (optional, separate consent): the agent can analyze your own sent mail of the last 90 days to draft a writing-style guide that you review and accept. The messages are analyzed and not stored.",
        ],
        after: [
          "The content of your mail and files goes only to the AI provider that generates the answer you asked for. It is never used to train models, never sold and never used for advertising. The details are in the privacy policy.",
        ],
      },
    ],
    limitedUseHeading: "Limited Use of Google user data",
  },
}
const effective = { es: "9 de noviembre de 2026", en: "9 November 2026" }
export const privacyPolicy: Record<Locale, SiteDocument> = {
  es: {
    title: "Política de privacidad",
    updated: effective.es,
    intro: [
      `Esta política explica qué datos trata Agentonic, operado por ${OPERATOR} ("Avilabs", "nosotros"), cuando usas la plataforma en app.agentonic.avilabs.tech, y en particular qué hacemos con los datos de tu cuenta de Google cuando la conectas a un agente.`,
      "Agentonic es una plataforma para empresas. Tu cuenta la crea por invitación la organización (el espacio de trabajo) a la que perteneces; esa organización decide qué agentes existen y quién los usa.",
    ],
    sections: [
      {
        heading: "1. Datos de tu cuenta de Agentonic",
        bullets: [
          "Identificación: tu correo electrónico, el nombre que eliges mostrar y tus credenciales de acceso, gestionadas por Supabase Auth. Los miembros con rol de administración de tu espacio ven tu correo.",
          "Lo que creas en la plataforma: agentes, instrucciones, documentos que subes, conversaciones con los agentes y los resultados de sus evaluaciones.",
          "Registros de actividad sin contenido: qué operación ocurrió, cuándo y con qué resultado, para auditoría y seguridad. No guardan el texto de tus correos, archivos ni mensajes.",
        ],
      },
      {
        heading: "2. Datos de Google a los que accedemos",
        paragraphs: [
          "Solo accedemos a tu cuenta de Google si tú la conectas a un agente, con los permisos que Google te muestra en su pantalla de consentimiento. Pedimos los permisos más estrechos que permiten cada función:",
        ],
        bullets: [
          "Gmail (https://www.googleapis.com/auth/gmail.modify): la dirección de la cuenta; los correos e hilos (remitentes, destinatarios, asuntos, fechas, etiquetas y contenido) que el agente busca o lee a petición tuya; los borradores que crea, actualiza o elimina; los correos que envía; y las etiquetas de usuario que crea o aplica tras tu confirmación. Este permiso permitiría también archivar o mover a la papelera; Agentonic no lo hace nunca.",
          "Google Drive (https://www.googleapis.com/auth/drive.file): el nombre, el tipo, la fecha de modificación y el contenido de los archivos que seleccionas con el selector de Google, y de los documentos que el agente crea o actualiza con tu confirmación. No vemos ningún otro archivo de tu Drive.",
        ],
      },
      {
        heading: "3. Para qué usamos los datos de Google",
        bullets: [
          "Responderte: el agente lee los correos o archivos que tu petición requiere y redacta la respuesta en tu conversación. El correo se lee cuando lo pides; no se sincroniza ni se importa al conocimiento del agente.",
          "Redactar, enviar y etiquetar por ti: cada borrador, envío o etiqueta se muestra con sus destinatarios y contenido exactos y se ejecuta solo tras tu confirmación. La única excepción es un envío o borrador que tú autorices por adelantado en una tarea programada: como máximo uno por ejecución, cancelable hasta que empieza.",
          "Conocimiento desde Drive: los archivos de Drive que importas a una colección de conocimiento se indexan para que el agente responda con citas. Se vuelven a leer periódicamente para reflejar tus cambios.",
          "Aprender tu estilo (solo con tu consentimiento aparte): analizamos hasta 200 de tus correos enviados de los últimos 90 días para redactar una guía de estilo que tú revisas y aceptas. Los correos no se guardan; solo se conserva la guía que aceptas.",
          "Seguridad y soporte: conservamos registros sin contenido de cada operación (por ejemplo, que se envió un correo y cuándo) para auditoría, para detectar abusos y para atender tus consultas.",
        ],
        after: [
          "No usamos los datos de Google para publicidad, para perfilarte, para decidir sobre créditos o seguros, ni para ningún fin distinto de ofrecerte y mejorar las funciones descritas aquí.",
        ],
      },
      {
        heading: "4. Con quién compartimos los datos",
        paragraphs: [
          "No vendemos datos personales ni datos de Google, y no los compartimos con intermediarios de datos ni con anunciantes. Los encargados que tratan datos por nuestra cuenta, únicamente para prestar el servicio, son:",
        ],
        bullets: [
          "OpenAI (API): recibe el texto de la conversación y el contenido de los correos o archivos necesarios para generar la respuesta que pediste, y las muestras para la guía de estilo. Usamos la API bajo condiciones que excluyen el entrenamiento de modelos con esos datos; OpenAI puede conservarlos hasta 30 días para detección de abusos.",
          "Voyage AI (API): recibe el texto de los documentos que importas al conocimiento, incluidos los de Drive, para calcular los índices de búsqueda, y fragmentos para ordenar los resultados. No entrena modelos con ellos.",
          "Supabase (Fráncfort, Alemania): aloja la base de datos, la autenticación y el almacenamiento de archivos.",
          "Microsoft Azure: aloja los servidores donde se ejecutan las aplicaciones y los agentes.",
          "Resend: envía los correos de la cuenta (invitaciones y restablecimiento de contraseña). No recibe datos de Google.",
          "Google: las API de Gmail y Drive, según las políticas de Google.",
        ],
        after: [
          "Podemos revelar datos cuando la ley lo exija. Nadie de Avilabs lee tus correos, archivos ni conversaciones, salvo que tú lo autorices expresamente para resolver una incidencia o la ley nos obligue.",
        ],
      },
      {
        heading: "5. Sin entrenamiento de modelos de IA",
        paragraphs: [
          "Los datos obtenidos de las API de Google, en bruto o derivados, no se usan para desarrollar, mejorar ni entrenar modelos de inteligencia artificial o aprendizaje automático, ni generalizados ni de terceros. Las únicas salidas personalizadas son las que tú pides para ti: la guía de estilo que revisas y aceptas, y las respuestas en tus conversaciones. Los proveedores de IA que usamos se contratan bajo condiciones que excluyen el entrenamiento con los datos que les enviamos.",
        ],
      },
      {
        heading: "6. Cómo protegemos los datos",
        bullets: [
          "Las credenciales de Google (tokens) se cifran con AES-256-GCM con una clave que no está en la base de datos y que se rota; se renuevan en cada uso y se borran al desconectar.",
          "Toda comunicación va cifrada (TLS). La base de datos aplica roles restringidos y políticas de seguridad por fila: cada aplicación y cada agente solo alcanza lo que le corresponde.",
          "Los agentes se ejecutan en servicios aislados sin acceso a la red ni a credenciales; una pasarela intermedia, con las claves, ejecuta cada llamada y comprueba la autorización en ese momento.",
          "Cada acción que escribe en tu cuenta exige tu confirmación, se ejecuta una sola vez y nunca se reintenta automáticamente si el resultado es incierto.",
          "Las evaluaciones automáticas y el personal de Avilabs nunca acceden a un buzón o Drive reales.",
        ],
      },
      {
        heading: "7. Cuánto tiempo conservamos los datos",
        bullets: [
          "Credenciales de Google: hasta que desconectas la cuenta, el espacio te da de baja o Google las revoca. Al desconectar se borran de inmediato y, si ninguna otra conexión tuya en Agentonic usa la misma cuenta, también revocamos el acceso en Google.",
          "Conversaciones (incluidas las respuestas que citan tu correo o tus archivos): 30 días desde el último mensaje. Cerrar una conversación borra su contenido de inmediato.",
          "Acciones pendientes de confirmación: sus argumentos (destinatarios, texto) se borran al ejecutarse, cancelarse o vencer; un barrido las revisa cada 15 minutos.",
          "Guía de estilo: hasta que la sustituyes, la borras o desconectas la cuenta. Los correos analizados no se guardan.",
          "Archivos de Drive importados al conocimiento: hasta que los quitas de la colección o desconectas la cuenta; entonces se borran el texto y los índices derivados.",
          "Registros de actividad sin contenido y datos de facturación: según la retención del espacio de trabajo, y como evidencia de auditoría.",
          "Copias de seguridad gestionadas por Supabase: caducan en un plazo de 7 días.",
        ],
      },
      {
        heading: "8. Tus derechos y cómo ejercerlos",
        bullets: [
          "Desconectar Google: en el agente, Configuración → Conexiones → Desconectar. También puedes retirar el acceso desde tu cuenta de Google en myaccount.google.com/permissions.",
          "Borrar datos: cerrar conversaciones, quitar archivos del conocimiento y desconectar cuentas borra lo descrito arriba. Para borrar tu cuenta o todos tus datos, escríbenos; lo atendemos en un plazo de 30 días.",
          "Acceder, corregir u oponerte: escríbenos a la dirección de contacto y te responderemos.",
        ],
      },
      {
        heading: "9. Cambios y contacto",
        paragraphs: [
          "Si cambiamos esta política, publicaremos la nueva versión en esta página con su fecha de vigencia y avisaremos en la aplicación cuando el cambio afecte a los datos de Google.",
          `Contacto: ${CONTACT_EMAIL}. Responsable: ${OPERATOR}.`,
        ],
      },
    ],
  },
  en: {
    title: "Privacy policy",
    updated: effective.en,
    intro: [
      `This policy explains what data Agentonic, operated by ${OPERATOR} ("Avilabs", "we"), processes when you use the platform at app.agentonic.avilabs.tech, and in particular what we do with your Google account data when you connect it to an agent.`,
      "Agentonic is a platform for businesses. Your account is created by invitation from the organization (the workspace) you belong to; that organization decides which agents exist and who uses them.",
    ],
    sections: [
      {
        heading: "1. Your Agentonic account data",
        bullets: [
          "Identification: your email address, the name you choose to display and your sign-in credentials, managed by Supabase Auth. Members with an administration role in your workspace see your email.",
          "What you create on the platform: agents, instructions, documents you upload, conversations with the agents and the results of their evaluations.",
          "Content-free activity records: which operation happened, when and with what outcome, for audit and security. They never hold the text of your mail, files or messages.",
        ],
      },
      {
        heading: "2. Google data we access",
        paragraphs: [
          "We access your Google account only if you connect it to an agent, with the permissions Google shows you on its consent screen. We request the narrowest scopes that allow each feature:",
        ],
        bullets: [
          "Gmail (https://www.googleapis.com/auth/gmail.modify): the account's address; the messages and threads (senders, recipients, subjects, dates, labels and content) the agent searches or reads at your request; the drafts it creates, updates or deletes; the messages it sends; and the user labels it creates or applies after your confirmation. This scope would also allow archiving or trashing; Agentonic never does either.",
          "Google Drive (https://www.googleapis.com/auth/drive.file): the name, type, modification date and content of the files you select with Google's picker, and of the documents the agent creates or updates with your confirmation. We see no other file in your Drive.",
        ],
      },
      {
        heading: "3. How we use Google data",
        bullets: [
          "Answering you: the agent reads the messages or files your request needs and writes the answer in your conversation. Mail is read when you ask; it is not synchronized or imported into the agent's knowledge.",
          "Drafting, sending and labeling for you: every draft, send or label is shown with its exact recipients and content and runs only after your confirmation. The only exception is a send or draft you pre-authorize in a scheduled task: at most one per run, cancellable until it starts.",
          "Knowledge from Drive: Drive files you import into a knowledge collection are indexed so the agent can answer with citations. They are re-read periodically to reflect your changes.",
          "Learning your style (only with your separate consent): we analyze up to 200 of your sent messages from the last 90 days to draft a writing-style guide that you review and accept. The messages are not stored; only the guide you accept is kept.",
          "Security and support: we keep content-free records of each operation (for example, that a message was sent and when) for audit, abuse detection and to answer your questions.",
        ],
        after: [
          "We do not use Google data for advertising, profiling, credit or insurance decisions, or any purpose other than providing and improving the features described here.",
        ],
      },
      {
        heading: "4. Who we share data with",
        paragraphs: [
          "We do not sell personal data or Google data, and we do not share them with data brokers or advertisers. The processors that handle data on our behalf, solely to provide the service, are:",
        ],
        bullets: [
          "OpenAI (API): receives the conversation text and the content of the messages or files needed to generate the answer you asked for, and the samples for the style guide. We use the API under terms that exclude training models on that data; OpenAI may retain it for up to 30 days for abuse detection.",
          "Voyage AI (API): receives the text of the documents you import into knowledge, including those from Drive, to compute search indexes, and passages to rank results. It does not train models on them.",
          "Supabase (Frankfurt, Germany): hosts the database, authentication and file storage.",
          "Microsoft Azure: hosts the servers where the applications and agents run.",
          "Resend: sends account emails (invitations and password resets). It receives no Google data.",
          "Google: the Gmail and Drive APIs, under Google's policies.",
        ],
        after: [
          "We may disclose data when the law requires it. Nobody at Avilabs reads your mail, files or conversations unless you expressly authorize it to resolve an issue or the law obliges us.",
        ],
      },
      {
        heading: "5. No AI model training",
        paragraphs: [
          "Data obtained from Google APIs, raw or derived, is not used to develop, improve or train artificial-intelligence or machine-learning models, whether generalized or third-party. The only personalized outputs are the ones you request for yourself: the style guide you review and accept, and the answers in your conversations. The AI providers we use are contracted under terms that exclude training on the data we send them.",
        ],
      },
      {
        heading: "6. How we protect data",
        bullets: [
          "Google credentials (tokens) are encrypted with AES-256-GCM using a key kept outside the database and rotated; they are refreshed on each use and erased on disconnect.",
          "All communication is encrypted (TLS). The database enforces restricted roles and row-level security policies: each application and each agent reaches only what belongs to it.",
          "Agents run in isolated services with no network access and no credentials; a gateway holding the keys performs each call and checks authorization at that moment.",
          "Every action that writes to your account requires your confirmation, runs exactly once and is never retried automatically when the outcome is uncertain.",
          "Automated evaluations and Avilabs staff never access a real mailbox or Drive.",
        ],
      },
      {
        heading: "7. How long we keep data",
        bullets: [
          "Google credentials: until you disconnect the account, the workspace removes you or Google revokes them. On disconnect they are erased immediately and, if no other connection of yours in Agentonic uses the same account, we also revoke access at Google.",
          "Conversations (including answers that quote your mail or files): 30 days from the last message. Closing a conversation erases its content immediately.",
          "Actions awaiting confirmation: their arguments (recipients, text) are erased when they run, are cancelled or expire; a sweep checks them every 15 minutes.",
          "Style guide: until you replace it, delete it or disconnect the account. The analyzed messages are not stored.",
          "Drive files imported into knowledge: until you remove them from the collection or disconnect the account; the text and derived indexes are then erased.",
          "Content-free activity records and billing data: per the workspace's retention, and as audit evidence.",
          "Backups managed by Supabase: expire within 7 days.",
        ],
      },
      {
        heading: "8. Your rights and how to exercise them",
        bullets: [
          "Disconnect Google: in the agent, Configuración → Conexiones → Desconectar. You can also withdraw access from your Google account at myaccount.google.com/permissions.",
          "Delete data: closing conversations, removing files from knowledge and disconnecting accounts erases what is described above. To delete your account or all your data, write to us; we handle it within 30 days.",
          "Access, correct or object: write to the contact address and we will answer.",
        ],
      },
      {
        heading: "9. Changes and contact",
        paragraphs: [
          "If we change this policy, we will publish the new version on this page with its effective date and notify you in the application when the change affects Google data.",
          `Contact: ${CONTACT_EMAIL}. Controller: ${OPERATOR}.`,
        ],
      },
    ],
  },
}
export const termsOfService: Record<Locale, SiteDocument> = {
  es: {
    title: "Términos del servicio",
    updated: effective.es,
    intro: [
      `Estos términos regulan el uso de Agentonic, operado por ${OPERATOR} ("Avilabs"). Al usar la plataforma aceptas estos términos y la política de privacidad.`,
    ],
    sections: [
      {
        heading: "1. El servicio",
        paragraphs: [
          "Agentonic permite a una organización configurar agentes de IA, darles instrucciones y documentos, conectarlos a cuentas de terceros como Gmail y Google Drive, evaluarlos y operarlos en conversaciones privadas. La plataforma está en fase de pruebas con clientes invitados; sus funciones pueden cambiar.",
        ],
      },
      {
        heading: "2. Cuentas",
        bullets: [
          "Las cuentas se crean por invitación de una organización. Eres responsable de tus credenciales y de lo que ocurre con tu cuenta.",
          "La organización titular del espacio de trabajo decide quién pertenece a él, qué agentes existen y quién puede usarlos.",
        ],
      },
      {
        heading: "3. Cuentas conectadas y acciones de los agentes",
        bullets: [
          "Solo conectas cuentas que te pertenecen o que estás autorizado a usar. Tú eliges qué acciones puede realizar cada agente con ellas y puedes desconectarlas en cualquier momento.",
          "Cada acción que cambia algo en una cuenta conectada se te muestra y requiere tu confirmación, salvo las que autorices expresamente por adelantado en una tarea programada. Eres responsable de las acciones que confirmas o autorizas.",
          "Las respuestas de los agentes las genera un modelo de IA y pueden contener errores. Revísalas antes de actuar sobre ellas.",
          "El uso de Gmail y Google Drive se rige además por los términos y políticas de Google.",
        ],
      },
      {
        heading: "4. Uso aceptable",
        paragraphs: ["No puedes usar Agentonic para:"],
        bullets: [
          "enviar correo comercial no solicitado, correo masivo o «calentar» cuentas de correo;",
          "acceder a cuentas o datos sin autorización, ni suplantar a nadie;",
          "contenido ilícito, dañino o que infrinja derechos de terceros;",
          "eludir los límites, presupuestos o controles de seguridad de la plataforma.",
        ],
        after: [
          "Podemos suspender un agente o una cuenta que incumpla estos términos o ponga en riesgo la plataforma o a otros usuarios.",
        ],
      },
      {
        heading: "5. Tus datos",
        paragraphs: [
          "Tus instrucciones, documentos, conversaciones y los datos de las cuentas que conectas son tuyos. Los tratamos solo para prestarte el servicio, según la política de privacidad, y nunca para entrenar modelos de IA.",
        ],
      },
      {
        heading: "6. Costos",
        paragraphs: [
          "Cada evaluación y cada despliegue tiene un presupuesto que fija la organización. El uso de los proveedores de IA se mide y se muestra; no se cobra nada que no esté autorizado por un presupuesto.",
        ],
      },
      {
        heading: "7. Disponibilidad y responsabilidad",
        paragraphs: [
          "Agentonic se ofrece «tal cual» durante la fase de pruebas, sin garantía de disponibilidad continua. En la medida en que la ley lo permita, Avilabs no responde por daños indirectos ni por decisiones tomadas a partir de las respuestas de un agente, y su responsabilidad total se limita a lo pagado por el servicio en los últimos doce meses.",
        ],
      },
      {
        heading: "8. Cambios, ley aplicable y contacto",
        paragraphs: [
          "Podemos actualizar estos términos; publicaremos la nueva versión en esta página con su fecha de vigencia. Estos términos se rigen por las leyes del lugar de constitución de Avilabs LLC.",
          `Contacto: ${CONTACT_EMAIL}.`,
        ],
      },
    ],
  },
  en: {
    title: "Terms of service",
    updated: effective.en,
    intro: [
      `These terms govern the use of Agentonic, operated by ${OPERATOR} ("Avilabs"). By using the platform you accept these terms and the privacy policy.`,
    ],
    sections: [
      {
        heading: "1. The service",
        paragraphs: [
          "Agentonic lets an organization configure AI agents, give them instructions and documents, connect them to third-party accounts such as Gmail and Google Drive, evaluate them and operate them in private conversations. The platform is in a trial phase with invited customers; its features may change.",
        ],
      },
      {
        heading: "2. Accounts",
        bullets: [
          "Accounts are created by invitation from an organization. You are responsible for your credentials and for what happens under your account.",
          "The organization that owns the workspace decides who belongs to it, which agents exist and who may use them.",
        ],
      },
      {
        heading: "3. Connected accounts and agent actions",
        bullets: [
          "You only connect accounts that belong to you or that you are authorized to use. You choose which actions each agent may take with them and can disconnect them at any time.",
          "Every action that changes something in a connected account is shown to you and requires your confirmation, except those you expressly pre-authorize in a scheduled task. You are responsible for the actions you confirm or authorize.",
          "Agent answers are generated by an AI model and may contain errors. Review them before acting on them.",
          "The use of Gmail and Google Drive is also governed by Google's terms and policies.",
        ],
      },
      {
        heading: "4. Acceptable use",
        paragraphs: ["You may not use Agentonic to:"],
        bullets: [
          'send unsolicited commercial email, bulk email, or "warm up" email accounts;',
          "access accounts or data without authorization, or impersonate anyone;",
          "create unlawful, harmful or infringing content;",
          "circumvent the platform's limits, budgets or security controls.",
        ],
        after: [
          "We may suspend an agent or an account that breaches these terms or endangers the platform or other users.",
        ],
      },
      {
        heading: "5. Your data",
        paragraphs: [
          "Your instructions, documents, conversations and the data of the accounts you connect are yours. We process them only to provide the service, as described in the privacy policy, and never to train AI models.",
        ],
      },
      {
        heading: "6. Costs",
        paragraphs: [
          "Each evaluation and each deployment has a budget set by the organization. AI provider usage is metered and shown; nothing is charged that a budget has not authorized.",
        ],
      },
      {
        heading: "7. Availability and liability",
        paragraphs: [
          'Agentonic is provided "as is" during the trial phase, without a guarantee of continuous availability. To the extent the law allows, Avilabs is not liable for indirect damages or for decisions taken on the basis of an agent\'s answers, and its total liability is limited to what was paid for the service in the last twelve months.',
        ],
      },
      {
        heading: "8. Changes, governing law and contact",
        paragraphs: [
          "We may update these terms; we will publish the new version on this page with its effective date. These terms are governed by the laws of the place of incorporation of Avilabs LLC.",
          `Contact: ${CONTACT_EMAIL}.`,
        ],
      },
    ],
  },
}
