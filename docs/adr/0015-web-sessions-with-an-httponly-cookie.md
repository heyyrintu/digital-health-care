# ADR 0015: Web sessions with an httpOnly cookie

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** Tech lead, platform owner
- **Related:** Build Plan §6.1 (sign-in and sessions), ADR 0002, ADR 0014, threat model T21

## Context
The staff dashboard runs in the browser. The API issues a 15-minute access token and a 12-hour rotating refresh token (ADR 0014, API guide §3). Wherever the browser keeps the refresh token decides how much a cross-site scripting bug could steal.

## Options considered
| Option | For | Against |
|---|---|---|
| Both tokens in `localStorage` | Simple | Any injected script can read and exfiltrate a 12-hour credential |
| Both tokens in memory only | Nothing persisted | Every reload or new tab signs the person out |
| Refresh token in an httpOnly cookie set by the web app's own server routes; access token in memory | Scripts can never read the long-lived credential; reloads restore the session | A thin server layer in the web app; cookie needs CSRF protection |

## Decision
The web app's route handlers under `/api/session/*` (login, mfa, invite, refresh, logout) call the API on the browser's behalf. On success they keep the refresh token in a `dhc_session` cookie — `HttpOnly`, `SameSite=Strict`, `Secure` in production, `Path=/api/session`, 12 hours — and return only the access token and its lifetime. The page holds the access token in memory, calls the API directly with it (CORS, ADR 0014), refreshes a minute before expiry, and signs out after 15 minutes without activity. Session routes accept only requests whose `Origin` is the web app itself.

## Consequences
- An XSS bug can use the current access token for at most 15 minutes while the page is open, but cannot read the refresh token.
- Logout and idle sign-out end the session at the API, not just in the browser.
- Completing a staff invite signs the person straight in.
- The API sees the web server as the client for these five routes. Before production, forward the client address through a trusted proxy hop so audit IPs and sign-in rate limits stay per person.

## Review trigger
A second web origin, server-rendered clinical pages, or moving the API behind the same origin as the web app.
