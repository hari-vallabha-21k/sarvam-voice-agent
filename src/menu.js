'use strict';

// SpiceGarden menu. Prices are in rupees, before GST.
// Kept in sync with the "Facts" section of the Sarvam agent prompt.
const MENU = [
  { id: 'paneer-butter-masala', name: 'Paneer Butter Masala', category: 'Main Course', price: 220, available: true },
  { id: 'butter-naan', name: 'Butter Naan', category: 'Breads', price: 40, available: true },
  { id: 'veg-biryani', name: 'Veg Biryani', category: 'Rice', price: 180, available: true },
  { id: 'dal-makhani', name: 'Dal Makhani', category: 'Main Course', price: 160, available: true },
  { id: 'chole-bhature', name: 'Chole Bhature', category: 'Main Course', price: 120, available: true },
  { id: 'jeera-rice', name: 'Jeera Rice', category: 'Rice', price: 110, available: true },
  { id: 'mixed-veg-curry', name: 'Mixed Veg Curry', category: 'Main Course', price: 150, available: true },
  { id: 'raita', name: 'Raita', category: 'Sides', price: 60, available: true },
  { id: 'mango-lassi', name: 'Mango Lassi', category: 'Drinks', price: 90, available: true },
  { id: 'gulab-jamun', name: 'Gulab Jamun', category: 'Desserts', price: 70, available: true },
];

const GST_RATE = 0.05;

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Loose match so "paneer butter masala", "Paneer masala" or "naan" still
// resolve to a menu item. Returns null when nothing is close enough.
function findMenuItem(name) {
  const n = normalize(name);
  if (!n) return null;
  const exact = MENU.find((m) => normalize(m.name) === n || m.id === n.replace(/ /g, '-'));
  if (exact) return exact;
  const contains = MENU.find((m) => n.includes(normalize(m.name)) || normalize(m.name).includes(n));
  if (contains) return contains;
  const words = n.split(' ').filter((w) => w.length > 2);
  let best = null;
  let bestScore = 0;
  for (const m of MENU) {
    const mw = normalize(m.name).split(' ');
    const score = words.filter((w) => mw.some((x) => x.startsWith(w) || w.startsWith(x))).length / mw.length;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

module.exports = { MENU, GST_RATE, findMenuItem, normalize };
