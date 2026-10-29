# Google restricted-scope verification for Gmail

**Prepared 7 October 2026 for outstanding action B5** (choose the Google path). This page explains what it takes to get Agentonic's Gmail access approved by Google for any customer, so the owner can weigh it against the alternatives. Requirements were checked against Google's documentation on 7 October 2026 (sources at the end); Google changes them, so recheck before starting.

## The short answer

- Agentonic asks for one Gmail scope, `gmail.modify` ([gmail-connection.md](gmail-connection.md), architecture §83). Google classes it as **restricted**, the strictest category. Until §83 it also asked for `gmail.readonly` and `gmail.compose`, which `gmail.modify` already covers.
- To let any Google account connect, Agentonic needs **restricted-scope verification**: brand verification, a scope review with a demo video, and an independent **security assessment (CASA)** by a Google-approved lab, **repeated every 12 months**.
- **Time:** several weeks at best, often two to three months the first time, mostly waiting on reviews and fixing assessment findings.
- **Money:** the security assessment is paid each year. Google's preferred lab (TAC Security) quotes US$540 to US$1,800 per app per year at Google's negotiated rate; other labs quote roughly US$1,800 to US$6,300. Engineering time for the homepage, privacy policy, video and any fixes comes on top.
- **Until then**, the app stays in _Testing_: at most 100 named test users, and every Gmail connection expires 7 days after the user consents, so people must reconnect weekly.

## Why it matters for Agentonic

|                            | Testing (today)                           | Verified (production)                      | Internal app                                                 |
| -------------------------- | ----------------------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| Who can connect            | Up to 100 test users we list by hand      | Any Google account                         | Only accounts in one Google Workspace organization we own    |
| Connection lifetime        | Expires 7 days after consent              | Lasts until revoked (or six months unused) | Lasts until revoked                                          |
| Consent screen             | "Google hasn't verified this app" warning | Normal screen                              | Normal screen                                                |
| Security assessment        | No                                        | Yes, yearly                                | No                                                           |
| Fits Agentonic's customers | Pilot only                                | Yes                                        | No: customers use their own Google accounts or organizations |

The Internal option only works if every user belongs to one Workspace organization, such as Avilabs' own staff. Customers would connect their own mailboxes, so it does not fit the product; it would only fit internal use.

## Steps to approval

Each step names who acts. The order matters: Google reviews the brand first, then the scopes, and only then asks for the security assessment.

### 1. Make the app eligible (Build, Owner)

- Keep the scopes to the minimum. Adding a label to a message ("Aplicar etiquetas", §68, `messages.batchModify`) needs `gmail.modify`; `gmail.labels` only manages label definitions. `gmail.modify` also covers reading, drafts and sending, so it is the only Gmail scope requested (§83). Google asks why narrower scopes aren't enough (text in step 6).
- The app must follow Google's [branding guidelines](https://developers.google.com/identity/branding-guidelines), the Google APIs Terms of Service and the [API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including **Limited Use** (see the mapping below).

### 2. Public homepage (Build, Owner)

- A page on our verified domain (for example `https://agentonic.avilabs.tech`), reachable without signing in, that describes what Agentonic does and how it uses Gmail. Today `app.agentonic.avilabs.tech` opens a sign-in page, which reviewers reject as a homepage.
- It links to the privacy policy and terms, and carries the Limited Use statement:
  > Agentonic's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

### 3. Privacy policy and terms (Owner, outstanding action D13)

The privacy policy sits on the same domain as the homepage and must say, plainly, how Agentonic accesses, uses, stores and shares Google user data:

- What we read (message metadata and content the user's agent asks for), why (to answer the user and draft or send mail they confirm), and that nothing is imported into knowledge or kept beyond the stated retention.
- Who else processes it: the AI provider that generates answers (OpenAI today), only to provide the feature, and never to train models. Name every outside service that handles mail content.
- That Google user data is **not used to develop, improve or train generalized AI or machine-learning models**, by us or anyone we share it with (Google Workspace API policy).
- That people at Agentonic do not read a user's mail, except with the user's explicit agreement for support or where the law requires it.
- How a user disconnects Gmail, deletes their data, and how long anything is kept.

### 4. Verify the domain (Owner)

In [Google Search Console](https://search.google.com/search-console), verify `avilabs.tech` (a DNS TXT record) with a Google account that is also an Owner or Editor of the Google Cloud project. Add it under _Authorized domains_ in the OAuth configuration.

### 5. Brand verification (Owner)

In Google Cloud console → _Google Auth Platform_ → _Branding_: app name "Agentonic", a 120×120 logo, support email, developer contact, homepage, privacy policy and terms links, authorized domains. Click **Verify branding**; the automated review usually takes minutes, and its result stays valid for 7 days, so **Publish branding** promptly after it passes.

### 6. Move to production and request data access (Owner, with Build's text)

- Set the publishing status to **In production**. With unverified restricted scopes the 100-user cap still applies until approval. Consents given from then on no longer expire after 7 days, so the same release sets `GOOGLE_TESTING` to false in `packages/connectors/src/google.ts` (§84, N26). Accounts connected while in Testing keep their date and reconnect once.
- Under _Data Access_, keep `gmail.modify` and remove `gmail.readonly` and `gmail.compose`, once the installed release asks only for `gmail.modify` (§83).
- In the _Verification Center_, paste this into "Explain to Google why you need these scopes, how you will use them, and why more limited scopes aren't sufficient" (written 28 October; recheck it against the product before submitting):

  > Agentonic lets a business user build an AI assistant ("agent") and connect their own Gmail account to it, so the agent can work through their mail with them. Connecting grants no actions: the account holder chooses, per agent, which Gmail actions it may take. Only the account holder's own conversations with that agent can use their mailbox; other members of their workspace and Agentonic staff cannot, and automated tests never touch a real mailbox.
  >
  > How we use gmail.modify:
  >
  > 1. Read and search: when the user asks (for example, "summarize what clients wrote this week"), the agent searches the mailbox and reads the matching messages or threads to answer. Mail is read when the user asks. The conversation keeps the agent's answer and the subjects of the messages it read, for that user, until the conversation is closed or expires. Mail is not imported into the agent's knowledge or used by any other feature.
  > 2. Drafts and sending: the agent writes replies in the right thread, and new messages, as drafts or ready to send. Every draft change, send and label change is shown to the user with its exact recipients and content, and runs only after the user confirms it. The one exception is a scheduled task the user creates and explicitly authorizes to send or draft without confirmation. It makes at most one such action per run, and the user can cancel it until it starts.
  > 3. Labels: the agent proposes labels for a batch of messages (for example, "Facturas" on ten invoices). After the user confirms, we create any missing user label and add it to those messages. We never remove labels, archive, trash or permanently delete mail. The only deletion is a draft the user confirms deleting.
  > 4. Writing style (optional, separate consent): the user can let the agent learn their writing style from their own sent mail of the last 90 days, at most 200 messages. The mail is analyzed and not stored. Only the style guide the user reviews and accepts is kept.
  >
  > Why narrower scopes aren't sufficient: adding a label to a message (messages.modify / messages.batchModify) requires gmail.modify. gmail.labels only manages label definitions, and gmail.readonly, gmail.compose and gmail.send can't change a message's labels. gmail.metadata isn't enough because the agent must read message bodies to answer, and gmail.send alone can't read or manage drafts. Since gmail.modify also covers reading, drafts and sending, we request it alone instead of adding gmail.readonly and gmail.compose. We don't request full access (https://mail.google.com/), since nothing in Agentonic permanently deletes mail.
  >
  > Data handling: message content goes only to our AI provider (the OpenAI API), only to produce the answer the user asked for, under terms that exclude training. Google user data is never used to train AI models, sold or used for advertising. Tokens are encrypted at rest and erased when the user disconnects. Our use complies with the Google API Services User Data Policy, including the Limited Use requirements.

  If the field caps the length, a shorter version (about 1,000 characters):

  > Agentonic lets a user connect their own Gmail account to an AI agent they configure, so the agent can work through their mail in their own conversations. It searches and reads messages and threads to answer the user's questions. It writes replies and new messages as drafts or sends them, and it proposes labels for batches of messages. Every draft change, send and label change is shown to the user with its exact content and runs only after they confirm. The exception is a send or draft the user explicitly pre-authorizes in a scheduled task: at most one per run, and cancellable. We request gmail.modify because adding labels to messages (messages.batchModify) isn't possible with gmail.labels, gmail.readonly, gmail.compose or gmail.send. It also covers reading and drafts, so we request no other Gmail scope and not full access: Agentonic never trashes, archives or permanently deletes mail. Mail goes only to our AI provider to produce the requested answer, is never used to train models, and is handled under Limited Use.

- Link up to three pages of documentation (the homepage's Gmail section and a help page).

### 7. Demo video (Build records, Owner uploads)

An **unlisted YouTube video in English** (narration or captions) that shows:

1. The full connection flow, with the **browser address bar showing our OAuth client ID** on Google's consent screen, and the app name as configured.
2. Every use of `gmail.modify` the text above names: the agent searching and reading mail and threads in a chat; creating, editing and deleting a draft and sending a message, each after its confirmation; a scheduled task with a pre-authorized send; a batch of labels confirmed on one card; and Aprender mi estilo.
3. Disconnecting Gmail and what happens to stored data.

Record on the hosted beta, after the §83 release is installed and `gmail.readonly` and `gmail.compose` are removed under _Data Access_, so Google's screen asks for `gmail.modify` alone. Google tells already-public apps to record new scopes in a staging environment or a separate project. The hosted beta is that staging environment: it is the nonproduction platform, accounts are invite-only, and §83 adds no scope (`gmail.modify` has been requested since §68). No separate Google Cloud project is needed; that is for apps that have reached the 100-user cap.

- Use a Gmail account made for the video, with a few synthetic messages (an invoice, a client question), listed under _Audience_ → _Test users_. Not the owner's mailbox used for live acceptance (B1), which holds real mail, and never a customer's.
- Connect it from a demo agent in a test workspace. Before consenting, click the address bar so the `client_id` in the URL is visible.
- Keep Google's "Google hasn't verified this app" screen in the video and click through it on camera; Google requires it to be shown.

### 8. Answer the reviewers (Owner, Build)

Google's Trust and Safety team writes back by email, often asking for changes to the video, wording or privacy policy. Each round takes days to weeks. Answer in the same thread.

### 9. Security assessment (Owner pays, Build fixes)

After the scope review, Google asks for a **Cloud Application Security Assessment (CASA)** because Agentonic's servers access the data:

- Google assigns the assurance level (AL1 or AL2) from the scopes, user count and other signals; it can rise later.
- An **App Defense Alliance-authorized lab** performs it against requirements based on the OWASP Application Security Verification Standard: scans of the hosted apps, questions about data handling, encryption, access control and deletion on request.
- We fix what the lab finds and rescan. The lab issues a **Letter of Validation**, which goes back to Google.
- TAC Security, Google's preferred lab, advertises one to three weeks from start to letter for a typical app.

### 10. Approval and yearly renewal

Google approves the scopes; the warning disappears and the 100-user cap and 7-day expiry stop applying. **Every 12 months** after the letter's date, Google emails a reminder: the app is reverified and the security assessment repeated (and paid again). Missing it can suspend Gmail access for every customer.

## What Agentonic already has, and what is missing

| Requirement                                                                                                         | Status                                                               |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Domain and hosted names (`*.agentonic.avilabs.tech`)                                                                | Done (C3)                                                            |
| Hosted OAuth callback registered                                                                                    | Done (C12)                                                           |
| One Gmail scope; confirmation for every write except a schedule's pre-authorized send or draft; no automatic resend | Built ([gmail-connection.md](gmail-connection.md), §58, §83)         |
| Tokens encrypted at rest, staff and automated evaluations never reach a real mailbox                                | Built                                                                |
| No model training on customer data                                                                                  | Platform decision (v1 defers any model training)                     |
| Live acceptance of the Gmail tools                                                                                  | Done on 8 October (B2)                                               |
| Scheduled cleanup of expired Gmail data                                                                             | Open: B3                                                             |
| Public homepage with a Gmail section and the Limited Use statement                                                  | Missing                                                              |
| Privacy policy, terms, list of outside services                                                                     | Missing: D13                                                         |
| Logo, support email, Search Console verification                                                                    | Missing (owner)                                                      |
| Demo video                                                                                                          | Missing; the test mailbox and a hosted test agent now exist (B1, B2) |
| Security assessment readiness (scans, data deletion on request, security headers, dependency audit)                 | Not started; expect findings to fix                                  |

## Limited Use, mapped to Agentonic

| Google's rule                                                         | How Agentonic meets it                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Use the data only for prominent user-facing features                  | Only the user's own agent, in the user's own conversations, uses the mailbox     |
| Transfer data only to provide those features, with the user's consent | Mail content goes only to the AI provider generating the answer, for that answer |
| No human reads the data without the user's agreement                  | Staff and automated evaluations never access a real mailbox                      |
| No selling, advertising or data brokers                               | None                                                                             |
| No training of generalized AI or ML models                            | No training by us; providers used under terms that exclude training on API data  |

## Decision for the owner (B5)

1. **Go for verification** if Agentonic will offer Gmail to customers outside one organization. Budget roughly US$540 to US$6,300 a year for the assessment plus engineering time, and two to three months before the first approval. Start with D13 (privacy policy) and the homepage, which every path needs anyway.
2. **Stay in Testing** for the pilot: up to 100 named users, weekly reconnection, and Google's warning screen. Fine for a small pilot, not for a launch.
3. **Internal app**: only if every user is in one Workspace organization we control.

Recording the choice in [gmail-connection.md](gmail-connection.md) closes B5; B6 then follows the steps above.

## Sources (checked 7 October 2026)

- Google: [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- Google: [Security assessment](https://support.google.com/cloud/answer/13465431)
- Google: [Restricted scopes list](https://support.google.com/cloud/answer/13464325)
- Google: [API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy) and [Workspace API user data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
- Testing-mode limits: [100-user cap and 7-day token expiry](https://www.unipile.com/google-oauth-100-user-limit/)
- Assessment pricing (third-party, may change): [TAC Security](https://tacsecurity.com/esof/), [Switch Labs comparison](https://www.switchlabs.dev/post/casa-tier-2-tier-3-security-review-providers-pricing-and-the-cheapest-option)
