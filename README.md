# Knowrevo

An AI sales-intelligence and cold-outreach workspace. It reads your prospect list, researches each business,
qualifies it against what you actually sell, writes a personalised email, and — once you approve it — sends it
from your own Gmail and tracks the conversation.

Everything is real: real Google Sheets reads and write-backs, real Gmail sends, real replies and bounces, real
Gemini calls. Nothing is simulated.

## What it does

1. **Knowledge base** — one master input plus sources (URLs or pasted text) is the only ground truth the AI uses
   for your offers, prices, proof and tone. Notes can be added for objections and policies.
2. **Leads** — import from Google Sheets (auto-detected columns), add manually, or generate candidates with the AI.
3. **Research** — fetches the prospect's website, captures verified facts with sources, and separates evidence
   from inference.
4. **Qualification** — scores 0-100 against your services and ideal customer, marks `not_qualified` or
   `needs_research` honestly instead of guessing.
5. **Composition** — writes subject and body, records the angle, rationale and the evidence used.
6. **Review** — nothing sends without an explicit approval, unless you turn on auto-approve for a campaign.
7. **Sending** — Gmail API, deterministic Message-ID per email so a retry never double-sends. Daily limits,
   interval, sending window and weekdays are enforced in `lib/mail.ts`.
8. **Conversations** — replies are classified, drafted answers are suggested, unsubscribes and bounces are
   suppressed automatically and stop all future contact.
9. **Follow-ups** — up to two nudges per sequence, cancelled the moment someone replies.
10. **Analytics** — funnel, reply rate by industry and by angle, plus an AI read of what to change.

## Multi-tenant by design

- Every row carries `owner_sub`; every query is scoped to the signed-in account.
- New accounts start empty: no seed leads, campaigns, knowledge or settings beyond safe sending defaults.
- API keys and Google tokens are encrypted at rest (`lib/crypto.ts`) and never returned to the browser.

## Configuration

Two things make the workspace work, both settable inside the app at **Integrations**:

| What | Who sets it | Where |
| --- | --- | --- |
| Google OAuth client (shared) | the workspace owner, once | paste the downloaded client JSON |
| Gemini API key | each account (or the owner, platform-wide) | Google AI Studio key |

With the shared Google client in place, **Connect Google** is a single click for everyone: Sheets and Gmail are
then both available for that account. The redirect URI to add in Google Cloud is shown on the Integrations page
(`<origin>/api/auth/google/callback`).

Environment variables are optional fallbacks (`GEMINI_API_KEY`, `GEMINI_MODEL`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`) plus local sign-in (`APP_PASSWORD`, `APP_SESSION_SECRET`) and token
encryption (`TOKEN_ENCRYPTION_KEY`). Keep secrets in `.env` / `.env.local`; both are gitignored.

## Development

```bash
npm install
npx next dev --port 3100
```

The database is Cloudflare D1. Locally it is created on first request by `lib/db.ts`
(`.wrangler/state`); on Cloudflare it is bound as `DB` per `wrangler.jsonc`. Schema migrations are versioned in
`app_meta` and applied automatically.

Sign in: `POST /api/session { "password": "$APP_PASSWORD" }`, or Sign in with Freebuff when `FREEBUFF_CLIENT_ID`
and `APP_ORIGIN` are present.

## Notes on the AI

- Default model is `gemini-3.5-flash`, with an automatic fallback chain (`lib/config.ts`) because Google retires
  model ids; a retired id otherwise breaks every AI feature with a 404.
- JSON responses use `responseSchema`. If a reply is truncated, the call is retried once with a larger token
  budget, since reasoning tokens count against `maxOutputTokens`.
- Thumbs-up/thumbs-down on an email go through the same validation as sending: no placeholders, no invented
  proof, no unsubscribe-less body.

## Compliance

Cold email is regulated. The app enforces a daily cap, a randomised interval, a sending window, weekday-only
sending, a persistent suppression list, an unsubscribe line in every email and automatic stop on replies and
bounces. You are still responsible for having a lawful basis to contact each prospect.
