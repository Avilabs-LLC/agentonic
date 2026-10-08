# Google restricted-scope verification for Gmail

**Prepared 7 October 2026 for outstanding action B5** (choose the Google path). This page explains what it takes to get Agentonic's Gmail access approved by Google for any customer, so the owner can weigh it against the alternatives. Requirements were checked against Google's documentation on 7 October 2026 (sources at the end); Google changes them, so recheck before starting.

## The short answer

- Agentonic asks for two Gmail scopes, `gmail.readonly` and `gmail.compose` ([gmail-connection.md](gmail-connection.md)). Google classes both as **restricted**, the strictest category.
- To let any Google account connect, Agentonic needs **restricted-scope verification**: brand verification, a scope review with a demo video, and an independent **security assessment (CASA)** by a Google-approved lab, **repeated every 12 months**.
- **Time:** several weeks at best, often two to three months the first time, mostly waiting on reviews and fixing assessment findings.
- **Money:** the security assessment is paid each year. Google's preferred lab (TAC Security) quotes US$540 to US$1,800 per app per year at Google's negotiated rate; other labs quote roughly US$1,800 to US$6,300. Engineering time for the homepage, privacy policy, video and any fixes comes on top.
- **Until then**, the app stays in *Testing*: at most 100 named test users, and every Gmail connection expires 7 days after the user consents, so people must reconnect weekly.

## Why it matters for Agentonic

| | Testing (today) | Verified (production) | Internal app |
|---|---|---|---|
| Who can connect | Up to 100 test users we list by hand | Any Google account | Only accounts in one Google Workspace organization we own |
| Connection lifetime | Expires 7 days after consent | Lasts until revoked (or six months unused) | Lasts until revoked |
| Consent screen | "Google hasn't verified this app" warning | Normal screen | Normal screen |
| Security assessment | No | Yes, yearly | No |
| Fits Agentonic's customers | Pilot only | Yes | No: customers use their own Google accounts or organizations |

The Internal option only works if every user belongs to one Workspace organization, such as Avilabs' own staff. Customers would connect their own mailboxes, so it does not fit the product; it would only fit internal use.

## Steps to approval

Each step names who acts. The order matters: Google reviews the brand first, then the scopes, and only then asks for the security assessment.

### 1. Make the app eligible (Build, Owner)

- Keep the scopes to the minimum. `gmail.readonly` (read and search) and `gmail.compose` (drafts and sending) are the narrowest scopes that support Agentonic's Gmail tools; `gmail.send` alone would not allow reading. Google asks for a justification of each one (draft wording below).
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

In [Google Search Console](https://search.google.com/search-console), verify `avilabs.tech` (a DNS TXT record) with a Google account that is also an Owner or Editor of the Google Cloud project. Add it under *Authorized domains* in the OAuth configuration.

### 5. Brand verification (Owner)

In Google Cloud console → *Google Auth Platform* → *Branding*: app name "Agentonic", a 120×120 logo, support email, developer contact, homepage, privacy policy and terms links, authorized domains. Click **Verify branding**; the automated review usually takes minutes, and its result stays valid for 7 days, so **Publish branding** promptly after it passes.

### 6. Move to production and request data access (Owner, with Build's text)

- Set the publishing status to **In production**. With unverified restricted scopes the 100-user cap still applies until approval.
- In the *Verification Center*, declare both scopes and paste the justifications. Draft:
  - `gmail.readonly`: "Agentonic lets a user give their own AI agent read access to their mailbox, so the agent can find and summarize the user's messages when the user asks in a chat. Reads happen only during the user's own conversation, for the connected account, and are not stored or imported into other features."
  - `gmail.compose`: "The user's agent drafts replies and new messages that the user reviews. Creating, changing or deleting a draft and sending any message each require the user's explicit confirmation in Agentonic; nothing is sent automatically."
- Link up to three pages of documentation (the homepage's Gmail section and a help page).

### 7. Demo video (Build records, Owner uploads)

An **unlisted YouTube video in English** (narration or captions) that shows:

1. The full connection flow, with the **browser address bar showing our OAuth client ID** on Google's consent screen, and the app name as configured.
2. Each scope in use: the agent reading and searching mail in a chat (`gmail.readonly`); creating, editing and deleting a draft, then sending a message after the explicit confirmation (`gmail.compose`).
3. Disconnecting Gmail and what happens to stored data.

Use a dedicated test mailbox with synthetic messages (outstanding action B1), never a real customer's mail.

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

| Requirement | Status |
|---|---|
| Domain and hosted names (`*.agentonic.avilabs.tech`) | Done (C3) |
| Hosted OAuth callback registered | Done (C12) |
| Narrow scopes, explicit confirmation for every write, no automatic resend | Built ([gmail-connection.md](gmail-connection.md)) |
| Tokens encrypted at rest, staff and automated evaluations never reach a real mailbox | Built |
| No model training on customer data | Platform decision (v1 defers any model training) |
| Live acceptance of the Gmail tools | Open: B1, B2 |
| Scheduled cleanup of expired Gmail data | Open: B3 |
| Public homepage with a Gmail section and the Limited Use statement | Missing |
| Privacy policy, terms, list of outside services | Missing: D13 |
| Logo, support email, Search Console verification | Missing (owner) |
| Demo video | Missing; needs B1 and a hosted test agent |
| Security assessment readiness (scans, data deletion on request, security headers, dependency audit) | Not started; expect findings to fix |

## Limited Use, mapped to Agentonic

| Google's rule | How Agentonic meets it |
|---|---|
| Use the data only for prominent user-facing features | Only the user's own agent, in the user's own conversations, uses the mailbox |
| Transfer data only to provide those features, with the user's consent | Mail content goes only to the AI provider generating the answer, for that answer |
| No human reads the data without the user's agreement | Staff and automated evaluations never access a real mailbox |
| No selling, advertising or data brokers | None |
| No training of generalized AI or ML models | No training by us; providers used under terms that exclude training on API data |

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
