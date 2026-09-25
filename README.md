# SpiceGarden: Sarvam voice agent restaurant dashboard

Customers call the Sarvam voice agent to order food or book a table. When each
call ends, Sarvam posts the captured details to this server, and the kitchen
dashboard updates live.

- **Dashboard** (`/`): cards for **Orders**, **New**, **Cooking** and **Completed**
  for the day picked in the Orders card (today by default), plus that day's order
  table with **Order ID, Customer name, Dish and Quantity**, type, total and status.
  Orders arrive as **New**; staff click **Start cooking**, then **Mark completed**,
  and the cards update at once. **Download CSV** exports every order between two dates.
  Order IDs run in sequence with no gaps (ORD-1001, ORD-1002, ...).
  Table bookings are listed below. Works on phones, supports light and dark mode,
  and refreshes every 5 seconds.
- **Sarvam-compatible API**: a post-call webhook plus the five agent tools
  (`get_menu`, `check_table_availability`, `create_booking`, `place_order`,
  `send_confirmation_sms`).
- No dependencies. Needs only Node.js 18 or newer. Data is stored in Supabase
  when `SUPABASE_URL` is set (production), otherwise in `data/db.json`.

## Run it

```bash
cp .env.example .env        # optional; set WEBHOOK_SECRET before going live
npm start                   # http://localhost:3000
npm run seed                # optional: load sample calls
npm test
```

(`npm start` does not read `.env` by itself. Export the variables, or run
`node --env-file=.env src/server.js` on Node 20.6 or newer.)

## Connect Sarvam

See **[sarvam/agent-setup.md](sarvam/agent-setup.md)**. It has the exact agent
variables, the post-call webhook, and the tool definitions for the Sarvam MCP.

## API

Endpoints under `/api/sarvam` and `/api/tools` require
`Authorization: Bearer $WEBHOOK_SECRET` (or `X-API-Key`) when `WEBHOOK_SECRET` is set.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/sarvam/webhook` | Post-call webhook. Creates the order and/or booking from agent variables |
| GET/POST | `/api/tools/get_menu` | Menu with prices |
| POST | `/api/tools/check_table_availability` | `booking_date`, `booking_time`, `party_size` → `available`, `alternative_times` |
| POST | `/api/tools/create_booking` | Creates a table booking |
| POST | `/api/tools/place_order` | Sends an order to the kitchen (status `cooking`) |
| POST | `/api/tools/send_confirmation_sms` | Texts the order or booking summary (Twilio, or logged when unset) |
| GET | `/api/stats?date=YYYY-MM-DD` | For that day (default today): `orders`, `new`, `cooking`, `completed`, `cancelled`, plus `all_time_orders` |
| GET | `/api/orders?date=&status=&q=` | Order list, newest first. `date` limits it to one day |
| GET | `/api/orders/export?from=&to=` | CSV of orders placed between two dates (inclusive, max 366 days) |
| PATCH | `/api/orders/:id` | `{ "status": "new" \| "cooking" \| "completed" \| "cancelled" }` |
| GET | `/api/bookings` | Table bookings |
| PATCH | `/api/bookings/:id` | `{ "status": "confirmed" \| "seated" \| "cancelled" \| "no_show" }` |
| GET | `/api/calls` | Recent post-call webhook log |

### Webhook payload

The webhook is tolerant about shape. Variables can be flat, nested under
`agent_variables` / `variables` / `data`, or wrapped as `{ "value": ... }`.
`order_items` can be free text (`"2 x Paneer Butter Masala, Butter Naan x 4, one Mango Lassi"`),
a JSON string, or an array of `{ name, quantity }`. Dishes are matched to the
menu to price the order (5% GST added). Anything not on the menu is kept and
marked "not on menu" on the dashboard.

```json
{
  "call_id": "abc123",
  "customer_name": "Asha Reddy",
  "customer_phone": "+919876500001",
  "order_items": "2 x Paneer Butter Masala, 4 x Butter Naan",
  "order_type": "takeaway",
  "booking_date": "2026-09-27",
  "booking_time": "20:00",
  "party_size": "4",
  "disposition": "order_placed"
}
```

## Deploying

Production runs on **Vercel** with **Supabase** for storage.

1. **Supabase**: run `supabase/migrations/*.sql` in the SQL editor, then set the
   app secret the server will send:
   `insert into private.app_config (app_secret) values ('<long random string>');`
   Every table has RLS on, and the only policy requires that secret in the
   `x-app-secret` header, so the publishable key alone can read or write nothing.
2. **Vercel**: import the repo. `vercel.json` routes every path to `api/index.js`
   (region `bom1`, Mumbai). Set these environment variables:
   `SUPABASE_URL`, `SUPABASE_KEY` (publishable key), `SUPABASE_APP_SECRET`,
   `WEBHOOK_SECRET`, `DASHBOARD_PASSWORD`, plus any of the optional ones in `.env.example`.
3. **Sarvam**: point the agent's tools and post-call webhook at the Vercel URL
   (see `sarvam/agent-setup.md`).

The dashboard asks for a login (any username, `DASHBOARD_PASSWORD`) when that
variable is set. `/api/sarvam/*` and `/api/tools/*` use `WEBHOOK_SECRET` instead,
and `/api/health` is open.

Any other Node host also works: run `npm start` with the same environment variables.
