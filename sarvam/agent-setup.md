# Connecting the Sarvam voice agent

This backend works with the Sarvam agent **SpiceGarden Order Assistant**
(`Conversatio-dfef8c78-0704`). You connect it in three steps: agent variables,
mid-call tools, and the post-call webhook. Every step can be done from the
Sarvam MCP (`configure_agent`, `create_api_tool`) or from the Sarvam dashboard.

Production runs at `https://sarvam-voice-agent-teal.vercel.app` and the agent
(version 3) is already connected to it:

| Agent tool | When | Endpoint |
|---|---|---|
| `place_order` | After the caller confirms a food order | `POST /api/tools/place_order` |
| `check_table_availability` | After date, time and guests are collected | `POST /api/tools/check_table_availability` |
| `create_booking` | After the caller confirms the booking | `POST /api/tools/create_booking` |
| `send_call_to_dashboard` | When every call ends (on_end) | `POST /api/sarvam/webhook` |

All four send `Authorization: Bearer <WEBHOOK_SECRET>`. `place_order` saves the
returned `order_id` and `create_booking` saves `booking_id`; the on-end webhook
sends both back, so the call summary lands on the same order and booking.
Booking tools take the date as the caller says it (today, tomorrow, saturday,
27 September) and reply with a spoken `message`, used as the tool's
`resp_template` (`{{message}}`). The steps below are the reference for rebuilding it.

Replace `https://YOUR-HOST` with the public HTTPS URL where this server runs,
and `YOUR_SECRET` with the value of `WEBHOOK_SECRET`.

> Sarvam can only reach a public **https** URL. For local testing, expose port
> 3000 with a tunnel (for example `cloudflared tunnel --url http://localhost:3000`
> or `ngrok http 3000`).

## 1. Agent variables (captured after each call)

Add these with `configure_agent` → `config.llm_config.agent_config.agent_variables`.
`update_post_interaction: true` makes Sarvam fill each one from the transcript
when the call ends.

| Variable | Type | Post-interaction prompt |
|---|---|---|
| `customer_name` | string | The caller's name as they gave it |
| `customer_phone` | string | The caller's phone or WhatsApp number, digits only with country code |
| `order_items` | string | Every item ordered with its quantity, formatted as `2 x Paneer Butter Masala, 4 x Butter Naan`. Empty if nothing was ordered |
| `order_type` | enum: `dine-in`, `takeaway`, `delivery`, `none` | How the order will be fulfilled |
| `delivery_address` | string | Full delivery address, empty unless it's a delivery order |
| `booking_date` | string | Table booking date as YYYY-MM-DD, empty if no table was booked |
| `booking_time` | string | Table booking time as 24-hour HH:MM, empty if no table was booked |
| `party_size` | string | Number of guests for the table booking, as digits |

The existing `disposition` variable is also read. `order_cancelled` or `no_order` means no order is created.

Example MCP call (merge; leaves existing variables untouched):

```json
{
  "agent_id": "Conversatio-dfef8c78-0704",
  "config": {
    "llm_config": { "agent_config": { "agent_variables": {
      "customer_name":  { "type": "string", "value": "", "description": " ", "update_post_interaction": true, "post_interaction_prompt": "The caller's name as they gave it" },
      "customer_phone": { "type": "string", "value": "", "description": " ", "update_post_interaction": true, "post_interaction_prompt": "The caller's phone or WhatsApp number, digits only with country code" },
      "order_items":    { "type": "string", "value": "", "description": " ", "update_post_interaction": true, "post_interaction_prompt": "Every item ordered with its quantity, formatted as '2 x Paneer Butter Masala, 4 x Butter Naan'. Empty if nothing was ordered" },
      "delivery_address": { "type": "string", "value": "", "description": " ", "update_post_interaction": true, "post_interaction_prompt": "Full delivery address, empty unless it is a delivery order" },
      "booking_date":   { "type": "string", "value": "", "description": " ", "update_post_interaction": true, "post_interaction_prompt": "Table booking date as YYYY-MM-DD, empty if no table was booked" },
      "booking_time":   { "type": "string", "value": "", "description": " ", "update_post_interaction": true, "post_interaction_prompt": "Table booking time as 24-hour HH:MM, empty if no table was booked" },
      "party_size":     { "type": "string", "value": "", "description": " ", "update_post_interaction": true, "post_interaction_prompt": "Number of guests for the table booking, as digits" }
    } } }
  }
}
```

## 2. Post-call webhook (runs after every call)

Point the agent's **on-end** hook at the webhook. With the MCP this is
`create_api_tool` with `lifecycle: "on_end"`:

```json
{
  "agent_id": "Conversatio-dfef8c78-0704",
  "name": "send_call_to_restaurant",
  "description": "Sends the captured order and booking to the restaurant dashboard when the call ends",
  "lifecycle": "on_end",
  "method": "POST",
  "url": "https://YOUR-HOST/api/sarvam/webhook",
  "headers": { "Authorization": "Bearer YOUR_SECRET" },
  "body": {
    "customer_name":    "{{customer_name}}",
    "customer_phone":   "{{customer_phone}}",
    "order_items":      "{{order_items}}",
    "order_type":       "{{order_type}}",
    "delivery_address": "{{delivery_address}}",
    "booking_date":     "{{booking_date}}",
    "booking_time":     "{{booking_time}}",
    "party_size":       "{{party_size}}",
    "call_summary":     "{{call_summary}}",
    "disposition":      "{{disposition}}"
  }
}
```

The webhook accepts the variables flat (as above), nested under
`agent_variables` / `variables` / `data`, or wrapped as `{ "name", "value" }`
objects. So Sarvam's own webhook format works without changes. If a
`call_id` / `interaction_id` is present, a re-delivered webhook updates the
existing order and doesn't create a duplicate.

## 3. Mid-call tools (optional but recommended)

These let the agent act during the call: check tables, book, read the live
menu, push the order to the kitchen, and text a confirmation. Create each with
`create_api_tool` (`lifecycle: "run"`, header `Authorization: Bearer YOUR_SECRET`).
Every response includes a `message` field. Set `resp_template` to
`{{message}}` and `on_failure` to a short apology.

| Tool | Method + URL | Body fields (source) |
|---|---|---|
| `get_menu` | `GET /api/tools/get_menu` | none |
| `check_table_availability` | `POST /api/tools/check_table_availability` | `booking_date` (agent decides: today, tomorrow, saturday, 27 September or YYYY-MM-DD), `booking_time` (agent decides: 8 pm or 20:00), `party_size` (agent decides, Number) |
| `create_booking` | `POST /api/tools/create_booking` | `customer_name`, `customer_phone`, `booking_date`, `booking_time`, `party_size`, `notes` (agent decides). Save `booking_id` to a `booking_id` variable |
| `place_order` | `POST /api/tools/place_order` | `customer_name`, `customer_phone`, `order_type` (One of: dine-in, takeaway, delivery), `order_items` (agent decides: "2 x Veg Biryani, 1 x Raita"), `delivery_address` |
| `send_confirmation_sms` | `POST /api/tools/send_confirmation_sms` | `customer_phone`, `customer_name` (agent decides) |

Then reference them from the prompt, for example in the order summary phase:
`After the user confirms the order, call tool:place_order , then call tool:send_confirmation_sms .`

When the agent both calls `place_order` mid-call and fires the post-call
webhook, link them so the order is updated, not duplicated. The live agent
does this with an `order_id` agent variable: `place_order` saves the
response's `order_id` into it (`save_to_variables`), and the on-end webhook
sends `"order_id": "{{order_id}}"`. The webhook then fills in the summary on
that order, or cancels it when the disposition is `order_cancelled`. A shared
`call_id` works the same way.

## 4. Commit and deploy

Commit the draft (`agents(operation="commit")`) and deploy it to your phone
number. Place a test call and the order appears on the dashboard within 5
seconds.

## Testing without a phone call

```bash
curl -X POST https://YOUR-HOST/api/sarvam/webhook \
  -H 'Authorization: Bearer YOUR_SECRET' -H 'Content-Type: application/json' \
  -d '{"call_id":"test-1","customer_name":"Asha","customer_phone":"+919876543210",
       "order_items":"2 x Paneer Butter Masala, 4 x Butter Naan","order_type":"takeaway"}'
```
