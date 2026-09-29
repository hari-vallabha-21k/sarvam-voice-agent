# WhatsApp service (Baileys)

Always-on Node 20+ service that sends the order and booking confirmations. It
must run somewhere that stays up (Render paid instance, Railway, a VPS), not on
Vercel. Baileys is unofficial and against WhatsApp's terms: use a dedicated
number for demos and pilots, and move to the official Meta Cloud API before
selling widely.

## Environment
| Variable | Purpose |
|---|---|
| `WA_SERVICE_SECRET` | 16+ characters. The same value goes in Vercel as `WA_SERVICE_SECRET` |
| `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_APP_SECRET` | Same as the dashboard; stores the login in `public.wa_auth` (run `supabase/migrations/20260929000000_wa_auth.sql`). Without them the login is kept in `./auth` |
| `PORT` | Default 3001 |

## Deploy and link
1. Deploy `wa-service/` (build `npm install`, start `npm start`).
2. In Vercel set `WA_SERVICE_URL=https://<service-url>` and `WA_SERVICE_SECRET`.
3. Open `https://<service-url>/link?key=<WA_SERVICE_SECRET>` and scan the QR code:
   WhatsApp > Settings > Linked devices > Link a device.
4. Check `GET /status` (Bearer secret) shows `connected: true`, then place a test order.

`POST /send {"to":"919811011111","text":"..."}` sends a message. Until it is
linked it answers 503, and the dashboard app just logs the failure.
