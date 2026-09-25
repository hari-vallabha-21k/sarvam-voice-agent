'use strict';

// Sends a few sample post-call webhooks to a running server so the dashboard
// has something to show:  npm start  then  npm run seed
const base = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const headers = { 'Content-Type': 'application/json' };
if (process.env.WEBHOOK_SECRET) headers.Authorization = `Bearer ${process.env.WEBHOOK_SECRET}`;
// Dashboard endpoints (order list, status change) use the dashboard login instead.
const dashHeaders = { 'Content-Type': 'application/json' };
if (process.env.DASHBOARD_PASSWORD) dashHeaders.Authorization = 'Basic ' + Buffer.from(`seed:${process.env.DASHBOARD_PASSWORD}`).toString('base64');

const calls = [
  { call_id: 'demo-1', customer_name: 'Asha Reddy', customer_phone: '+919876500001', order_type: 'takeaway', order_items: '2 x Paneer Butter Masala, 4 Butter Naan, one Mango Lassi', disposition: 'order_placed' },
  { call_id: 'demo-2', customer_name: 'Rahul Verma', customer_phone: '+919876500002', order_type: 'dine-in', order_items: [{ name: 'Veg Biryani', quantity: 3 }, { name: 'Raita', quantity: 3 }], booking_date: 'tomorrow', booking_time: '8 pm', party_size: '3', disposition: 'order_placed' },
  { call_id: 'demo-3', customer_name: 'Lakshmi N', customer_phone: '+919876500003', order_type: 'delivery', order_items: 'Dal Makhani x 1, Jeera Rice x 2, Gulab Jamun x 2', delivery_address: '12 MG Road, Indiranagar', disposition: 'order_placed' },
  { call_id: 'demo-4', agent_variables: { customer_name: { value: 'Imran Khan' }, customer_phone: { value: '+919876500004' }, order_items: { value: '1 Chole Bhature and 2 Mango Lassi' }, order_type: { value: 'takeaway' } } },
  { call_id: 'demo-5', customer_name: 'Priya S', customer_phone: '+919876500005', booking_date: 'tomorrow', booking_time: '13:00', party_size: 6, order_type: 'dine-in', disposition: 'no_order' },
];

(async () => {
  for (const body of calls) {
    const res = await fetch(`${base}/api/sarvam/webhook`, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json();
    console.log(res.status, body.call_id, data.order ? data.order.id : '-', data.booking ? data.booking.id : '-');
  }
  // Mark the first order completed so all three KPI states show up.
  const { orders } = await (await fetch(`${base}/api/orders`, { headers: dashHeaders })).json();
  const first = orders.find((o) => o.call_id === 'demo-1');
  if (first) await fetch(`${base}/api/orders/${first.id}`, { method: 'PATCH', headers: dashHeaders, body: JSON.stringify({ status: 'completed' }) });
})();
