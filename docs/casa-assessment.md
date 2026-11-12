# CASA AL1 assessment

Google asked on 12 November 2026 for an **ADA-CASA AL1** assessment of project `agentonic-509018` by **9 February 2027**. The assessment is renewed every year. AL1 is a verified self-assessment: Agentonic supplies evidence for each test case, and an ADA-authorized lab reviews it. A dynamic scan, run by us or by the lab, is evidence for about half the cases. This page answers every test case in the [CASA Specification 2.1.1](https://github.com/appdefensealliance/ASA-WG/blob/main/CASA/CASA%20Specification.md) and its [Test Guide](https://github.com/appdefensealliance/ASA-WG/blob/main/CASA/CASA%20Test%20Guide.md). It covers the code as of platform 0.53.0 (§87).

Once the lab has issued its Letter of Validation, reply in Google's thread to confirm. Google's verification steps are in [google-restricted-scope-verification.md](google-restricted-scope-verification.md).

## Scope

The application under test is the customer app, `https://app.agentonic.avilabs.tech`, which holds the Google OAuth client. Two other targets go to the lab if it asks: the staff Admin app, `https://admin.agentonic.avilabs.tech`, which shares its backend, and the public site, `https://agentonic.avilabs.tech`, which is static. All three run on one Azure VM, `vm-agents-01`, behind Caddy.

Third-party services in scope for authentication, session and access-control cases:

- **Supabase Auth**: passwords, sessions, email links and the staff TOTP factor.
- **Google OAuth 2.0**: Gmail `gmail.modify` and Drive `drive.file`, each in its own consent.

Test account for an authenticated scan: `google-review@avilabs.tech`, an administrator of the isolated "Revisión Google" workspace. Its password is in `.local/google-reviewer.txt`, and rerunning `pnpm setup:google-reviewer` sets a new one. Never commit it or paste it into a document.

## Owner actions before submitting

1. **Supabase dashboard, Authentication.** The repository has no Management API token, so each setting needs a screenshot:
   - **Password security:** minimum length **10**, the same rule the apps enforce in `newPasswordSchema`. Turn on **Prevent use of leaked passwords**, which the paid plan includes. This is the 1.1.1 control: a minimum length plus a ban on breached passwords.
   - **Email OTP expiration:** at most **3600 seconds**, for the invitation and reset links.
   - **Access token (JWT) expiry:** at most **3600 seconds** (2.2.3).
   - **Multi-factor:** TOTP enabled. It is already used by staff.
2. **Qualys SSL Labs:** save the result pages as PDFs for `app.`, `admin.` and `agentonic.avilabs.tech` (4.1.1, 4.1.2). All three scored **A+** on 12 November, with TLS 1.2 and 1.3 only, HSTS, forward secrecy and no certificate issues. Rescan just before submitting.
3. **DNS:** take a screenshot of the `avilabs.tech` zone at GoDaddy (6.4.1).
4. **The dynamic scan:** let the lab run its authenticated scan, Burp Suite with the ADA configuration, using the test account above. Fix what it reports and ask for a rescan.
5. **Logs:** after one sign-in, export the customer app's journal, run `journalctl -u agentonic-customer-staging --since "10 min ago"` on the VM, and attach it (6.5.1).
6. **After the 0.53.0 install:** sign in to Admin once. Without an authenticator, the sign-in now asks you to enrol one (3.3.1).

## Evidence by test case

### 1 Authentication

| Case | Answer and evidence |
| --- | --- |
| 1.1.1 Brute force | External service: Supabase Auth. Supabase holds every password; the apps never store one (`packages/server/src/actions.ts`, `passwordSignIn`). Control: a minimum of 10 characters (`packages/contracts/src/identity.ts`, `newPasswordSchema`, and the Supabase setting above), with Supabase's leaked-password check (owner action 1) and its sign-in rate limits. Admin also requires a TOTP second factor for every staff member (3.3.1). |
| 1.1.2 Initial codes | No system-generated passwords: accounts exist only by invitation, and each person sets their own password. An invitation is a 256-bit random token from `crypto.randomBytes`. The database stores only its SHA-256. It is single-use, bound to one email address and valid for **48 hours** (`packages/server/src/access.ts`, `INVITATION_HOURS`). The sign-in link Supabase emails expires under the OTP setting above. |
| 1.1.3 Password storage | Supabase Auth stores passwords hashed with bcrypt. Agentonic stores no passwords. |
| 1.2.1 Default credentials | None. No account ships with the software. Staff and workspace owners are created by invitation (`scripts/bootstrap-accounts.mjs`, Equipo, Miembros). The reviewer test account has a random password that `pnpm setup:google-reviewer` replaces. |
| 1.3.1–1.3.4 Out-of-band verifiers | Email links are Supabase one-time `token_hash` verifiers, checked server-side with `verifyOtp` (`packages/server/src/account.ts`, `confirmEmailLink`). The format is checked before use. They expire under the Supabase OTP setting and are spent on first use. TOTP codes are 6 digits from a 30-second window, verified by Supabase MFA (`verifyAuthenticator`). Agentonic's own invitation tokens are 256-bit random, so 1.3.4's 64-bit threshold for rate limiting does not apply. |

### 2 Session management

| Case | Answer and evidence |
| --- | --- |
| 2.1.1 Tokens in URLs | Sessions live only in cookies. Passwords are posted in a server action body, never with GET. Two links carry one-time verifiers in the query string, and neither is a session token: `/auth/confirm?token_hash=…`, from Supabase, and `/invitation?token=…`. Pages send `Referrer-Policy: strict-origin-when-cross-origin` (customer) or `same-origin` (Admin) and `Cache-Control: private, no-store` (`packages/server/src/proxy.ts`). The Next.js request log skips the OAuth callback (`apps/customer/next.config.ts`). |
| 2.2.1 Logout | Sign-out calls Supabase `signOut({ scope: "local" })`, which deletes the session and its refresh tokens on the server, and removes the cookies (`packages/server/src/actions.ts`, `signOut`). Supabase Auth's `logout.go` deletes the session. |
| 2.2.2 Other sessions after a password change | Supabase Auth acts by default: `User.UpdatePassword` logs out every other session when the password changes, and every session after a reset (supabase/auth, `internal/models/user.go`). Both apps change passwords through `updateUser` (`changePassword`). |
| 2.2.3 Stateless tokens | The Supabase access token is a JWT that expires after the configured access token expiry (at most 1 hour; see owner action 1). Refresh tokens are stateful and revocable. |
| 2.3.1 / 2.3.2 Secure and HttpOnly | Session cookies `agentonic-customer-auth` and `agentonic-admin-auth` are set `HttpOnly`, `Secure` in production and `SameSite=Lax` (`packages/server/src/env.ts`, `authConfiguration`). The short-lived OAuth state cookies are the same, scoped to the callback path (`packages/server/src/gmail.ts`, `drive.ts`). The browser holds no Supabase client: every Auth call runs on the server. |
| 2.3.3 Dynamic tokens | Supabase issues a new session (JWT and refresh token) at each sign-in, refreshed in the proxy (`refreshSession`). |
| 2.3.4 JWT integrity | Each request is verified with Supabase: `getUser()` for identity (`packages/server/src/auth.ts`) and `getClaims()` in the proxy, which checks the signature. Cookie contents never establish identity. |
| 2.4.1 Sensitive changes | Changing a password needs a verified session (`requireVerifiedUser`) and, in Admin, a passed second factor. Invitations, roles, authorizations and connections run in server code that re-verifies the user and checks the database role for each call. |

### 3 Access control

| Case | Answer and evidence |
| --- | --- |
| 3.1.1–3.1.3 Least privilege, attributes, fail closed | Identity comes only from Supabase's server-side `getUser()`. Workspace and staff roles come from the database, never from the browser (`requireIdentity`). Every read and write runs in a transaction that sets the verified user, workspace and email as transaction-local settings (`packages/database/src/client.ts`, `withIdentity`). The apps connect as restricted roles `agentonic_customer` and `agentonic_admin`. Each role can only call reviewed `SECURITY DEFINER` functions, which check membership and role before acting, plus row-level security on application tables (Prisma migrations). Roles: workspace owner, admin, member and viewer; staff administrator, operator and support. Errors deny: functions raise `insufficient_privilege`, server code returns `{ ok: false }` with a generic message, and an unreadable second-factor level counts as missing (`tests/auth.test.ts`). |
| 3.1.4 IDOR | Every route and action that takes an identifier (workspace, agent, version, connection, document, conversation, schedule) passes it as a UUID to a database function. The function resolves the record inside the caller's workspace and checks the caller's role. A record from another workspace is "not found". Routes: `apps/customer/app/api/{chats,documents,documents/[id],drive,gmail,knowledge/search,previews,schedules,style,connections/google/*}` plus the server actions in `apps/*/app/actions.ts`. |
| 3.1.5 CSRF | Server actions use Next.js's built-in Origin and Host check. Every `POST` route refuses a request whose `Origin` host differs from `Host` (for example `apps/customer/app/api/gmail/route.ts`). Session cookies are `SameSite=Lax`. OAuth uses `state` (3.2.2). |
| 3.1.6 Directory browsing | Caddy only proxies to the two Next.js servers; it serves no files, so there is no listing (`scripts/platform-units.mjs`, `caddyfile`). |
| 3.2.1 OAuth flows | Google: authorization code with PKCE (S256) and a server-side code exchange (`packages/server/src/gmail.ts`, `startGmail`/`finishGmail`; `drive.ts`). No implicit or password grant. |
| 3.2.2 state and redirect_uri | `state` is 256-bit random. Its SHA-256 is stored with the pending connection, and the value is sealed in an HttpOnly cookie on the callback path, compared in constant time, and spent once (`oauth.consume`). `redirect_uri` is fixed by configuration (`GOOGLE_REDIRECT_URI`) and registered with Google. After the callback, the app goes only to a path it builds itself. |
| 3.3.1 Admin MFA | Admin requires a TOTP second factor in every staff session. A staff member without one enrols before anything opens, and it cannot be turned off (`packages/server/src/auth.ts`, `verifiedUser`; `apps/admin/app/mfa/page.tsx`; `secondFactorStep`; tests in `tests/auth.test.ts` and `tests/account-service.test.ts`). Admin offers application functions only; the VM, database and cloud consoles are not reachable through it. |

### 4 Communications

| Case | Answer and evidence |
| --- | --- |
| 4.1.1 / 4.1.2 TLS | Caddy with Let's Encrypt certificates, TLS 1.2 and 1.3 only, HSTS `max-age=63072000; includeSubDomains`. SSL Labs A+ on all three hosts (12 November; PDFs per owner action 2). HTTP redirects to HTTPS. Outbound connections: PostgreSQL over TLS verified against Supabase's CA (`AGENTONIC_DATABASE_CA_FILE`), and HTTPS to Supabase, Google, OpenAI, Voyage and Browserbase with Node's default certificate checks. |
| 4.1.3 Cryptography | AES-256-GCM, with a 96-bit random IV per value and associated data binding each value to its record, for Google refresh tokens, OAuth PKCE verifiers and stored tool arguments (`packages/connectors/src/secrets.ts`, `seal`). Keys are 256-bit, held only in server configuration, and named by a hash. Rotation: `pnpm connections:rotate-key` with standby keys. SHA-256 for invitation tokens, OAuth state and key names. Randomness comes from `crypto.randomBytes`. Password hashing and JWT signing are Supabase's. |
| 4.1.4 Failures | GCM authenticates before decrypting. Any failure, whether a wrong key, a tampered value or a bad format, raises the same `gmail_secret_unavailable`, and users see a generic message. There is no padding mode. |

### 5 Data validation

| Case | Answer and evidence |
| --- | --- |
| 5.1.1 Parameter pollution | Inputs are parsed with strict Zod schemas (`packages/contracts`); a repeated parameter is read once with `searchParams.get`. |
| 5.1.2 Redirects | `safeNext` allows only paths on the same app (`packages/contracts/src/identity.ts`, tested in `tests/account-service.test.ts`). Email links are built from configuration, never from the request's `Host` (`publicUrl`). |
| 5.1.3 / 5.1.4 Code and template injection | The web apps have no `eval`, `new Function`, child processes or server-side templates (checked with a code search). Agents' model output is data: it is rendered, never executed. |
| 5.1.5 SSRF | The apps fetch only fixed provider endpoints. An agent's `web.read` runs in the gateway, whose systemd unit denies private, link-local, CGNAT and Azure host addresses (`scripts/staging-units.mjs`, `gatewayDenied`). App services deny the metadata address `169.254.169.254` (`scripts/platform-units.mjs`). |
| 5.1.6 XML | The apps parse no XML. |
| 5.1.7 XSS | React escapes all output. Markdown renders without raw HTML (`react-markdown` without `rehype-raw`), and nothing uses `dangerouslySetInnerHTML`. Every page has a nonce-based Content Security Policy with `strict-dynamic`, `object-src 'none'`, `base-uri 'none'` and `frame-ancestors 'none'` (`packages/server/src/security.ts`). Downloads are sandboxed attachments (5.2.1). |
| 5.1.8 SQL injection | Prisma tagged templates and parameters only; no `$queryRawUnsafe` or `$executeRawUnsafe` anywhere in the apps. |
| 5.1.9 OS commands | None in the web apps. |
| 5.1.10 File inclusion | No route reads files by a user-supplied path. Documents are fetched by UUID from Supabase Storage. |
| 5.2.1 Uploads | `POST /api/documents` accepts only `text/plain`, `text/markdown` and `application/pdf`, within a size limit. A PDF must start with `%PDF-`, and text must be valid UTF-8. The route also checks the request's origin and the caller's workspace role (`packages/server/src/documents.ts`, `uploadDocument`). Files go to private Supabase Storage. Downloads are served as `attachment` with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, so nothing uploaded runs in the app's origin. |

### 6 Configuration

| Case | Answer and evidence |
| --- | --- |
| 6.1.1 Components | `pnpm audit --prod` reports no known vulnerabilities (12 November, after §87 moved Next.js to 16.4.6, Prisma to 7.10.1 and zod to 4.6.7, and patched two transitive packages). The Verify workflow runs this audit on every change (`.github/workflows/verify.yml`, job `audit`), and GitHub's Dependabot alerts are on. Development-only tools (the shadcn CLI, ESLint, Vitest) are not shipped. Their two remaining advisories are a low one in `deepmerge` (no fixed release) and a moderate one in `minimatch` (lint only). |
| 6.2.1 Debug modes | Releases are production builds (`NODE_ENV=production`, `next start` from the standalone output). There are no source maps for browsers and no `X-Powered-By` header (`poweredByHeader: false`), Caddy removes `Server`, and error pages show a generic message. |
| 6.3.1 Origin header | No CORS headers are sent, so no origin is trusted. `Origin` is only an extra CSRF check after the session is verified, never authentication. |
| 6.4.1 Subdomain takeover | `agentonic.`, `app.agentonic.` and `admin.agentonic.avilabs.tech` are A records for the VM's static IP, `158.158.16.6`. There is no wildcard. `www.avilabs.tech` points to an active Vercel project. Screenshot per owner action 3. |
| 6.5.1 Logs | The Next.js log is configured to omit server-function arguments, which can hold passwords, and to skip the OAuth callback (`apps/customer/next.config.ts`, `logging`). Server code logs only structured events without secrets (`document_upload_failed` with a reference and a code). Caddy writes no access log. Seven days of the apps' journals on 12 November: 1,368 lines and no password, token, JWT or key. |
| 6.6.1 Browser storage | The session is only in HttpOnly cookies, removed at sign-out. The only thing in local storage is the light/dark theme choice (`next-themes`), which is not confidential. |
| 6.7.1 Server-side secrets | Secrets live on the VM in `/etc/agentonic` (directory `0700`, files `0600`, owned by root) and reach each service through systemd `EnvironmentFile`. The database CA comes through `LoadCredential`. Each service gets only the names it needs, and the installer refuses to give an app the Supabase secret key (`scripts/install-platform.mjs`). Agents run without network or keys and reach providers through the gateway (architecture §§43–44). Google tokens are encrypted at rest (4.1.3). Every read or change of `/etc/agentonic` is recorded by auditd (rule `agentonic-secrets`, installed by `pnpm platform:install` since §87; search with `sudo ausearch -k agentonic-secrets`). SSH reaches the VM only from the owner's address, keys only. Supabase, Google Cloud and GitHub keep their own audit logs for console access. |

## Renewal

Every year: rerun `pnpm audit --prod` and SSL Labs, then update this page's dates and versions and the evidence, before contacting the lab.
