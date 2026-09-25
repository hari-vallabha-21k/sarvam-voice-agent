# SpiceGarden: Sarvam voice agent restaurant dashboard

Customers call the Sarvam voice agent to order food or book a table. When each
call ends, Sarvam posts the captured details to this server, and the kitchen
dashboard updates live.

- **Orders** (`/`): the day's order count and **New**, **Cooking**, **Completed** and
  **Cancelled** totals for the picked date (today by default), then a card per order
  with **Order ID, customer name, each dish and its quantity**, type and total.
  Orders arrive as **New**; staff click **Start cooking**, then **Mark completed**,
  and the counts update at once. Click a card for the full order (prices, GST,
  address, notes, call summary). Filter by status, search by order ID, name, phone
  or dish, and **Download CSV** for any date range. Order IDs run in sequence with
  no gaps (ORD-1001, ORD-1002, ...). New orders are highlighted as they arrive.
- **Tables** (`/tables`): a **Floor plan** with a card per table (T-01 to T-12 across
  Main Hall, Patio and Family Room) showing Available, Reserved or Occupied at the
  chosen date and time, with who booked it and when. Each reservation gets its own
  colour. Click a table to book it (guest count, day and a time grid with taken
  times struck through), seat the guests, free the table, cancel or mark a no-show.
  **Reservations** lists the whole day's bookings with their source (voice agent or
  front desk). Bookings that could not get a table wait in a strip at the top.
- **Calls** (`/calls`): every call the voice agent finished (from the post-call
  webhook), grouped by day, with its summary and links to the order or booking it
  produced.
- The pages share one design (Cormorant Garamond and DM Sans, cream and deep red),
  work on phones with a bottom tab bar, support light and dark mode, and refresh on
  their own (orders every 5 seconds, tables every 10, calls every 15).
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
| POST | `/api/tools/check_table_availability` | `booking_date`, `booking_time`, `party_size` → `available`, `table_id`, `alternative_times`, `message` |
| POST | `/api/tools/create_booking` | Books the smallest free table that fits → `booking_id`, `table_id`, `message` |
| POST | `/api/tools/place_order` | Sends an order to the kitchen (status `cooking`) |
| POST | `/api/tools/send_confirmation_sms` | Texts the order or booking summary (Twilio, or logged when unset) |
| GET | `/api/stats?date=YYYY-MM-DD` | For that day (default today): `orders`, `new`, `cooking`, `completed`, `cancelled`, plus `all_time_orders` |
| GET | `/api/orders?date=&status=&q=` | Order list, newest first. `date` limits it to one day |
| GET | `/api/orders/export?from=&to=` | CSV of orders placed between two dates (inclusive, max 366 days) |
| PATCH | `/api/orders/:id` | `{ "status": "new" \| "cooking" \| "completed" \| "cancelled" }` |
| GET | `/api/tables?date=&time=` | Every table's state at that moment (default now), that day's bookings, and bookings waiting for a table |
| GET | `/api/bookings?date=` | Table bookings |
| POST | `/api/bookings` | Staff booking: `customer_name`, `customer_phone`, `booking_date`, `booking_time`, `party_size`, optional `table_id`, `notes` |
| PATCH | `/api/bookings/:id` | `{ "status": "confirmed" \| "seated" \| "completed" \| "cancelled" \| "no_show" }` and/or `{ "table_id": "T-05" }` |
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
