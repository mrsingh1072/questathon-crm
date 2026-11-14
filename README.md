# FlytBase Questathon CRM

A live, evidence-backed Customer Success CRM for the two Questathon accounts. It keeps the AQ token on the server, stores MCP responses in SQLite, enforces a token-wide one-call-per-minute gate, and refreshes live signals without a browser reload.

## Run locally

1. Use Node 22.5 or later.
2. Copy `.env.example` to `.env` and set `AQ_TOKEN` to the Questathon token. Do not commit this file.
3. Run `npm start`, then open `http://localhost:3000`.
4. Choose **Initial sync** once. The server queues MCP work at least 60 seconds apart. It first stores accounts, then account paperwork, and thereafter checks signals. All raw source responses and notes are stored under `data/crm.sqlite`.

## What it shows

For both accounts the dashboard provides five manager questions: book value, power map, first moves, risks, and explicit unknowns. Every rendered numeric value is paired with the MCP record ID that supplied it. It intentionally labels incomplete evidence as unknown rather than making a financial or relationship claim.

## Live behavior

The browser polls this server every 15 seconds. The server performs no more than one MCP request per 60 seconds and only calls `get_signals` after initial account/paperwork data is stored. New signals are persisted; a compact factual note is written back with `write_note` on the next allowed slot.

## Deployment

Vercel serves the static frontend from `public/`; its `vercel.json` routes `/api/*` requests to the Render backend. Keep `AQ_TOKEN` configured only on Render.

## Security

`AQ_TOKEN` is read only by `server.mjs`. It is never returned from an API endpoint, written to SQLite, bundled into the client, or included in this repository.
