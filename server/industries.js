// ── Industry profiles ─────────────────────────────────────────────────────────
// One multitenant codebase serves multiple verticals (barbershop, detail shop,
// nail studio, …). A shop's `industry` selects a profile here, which drives the
// UI vocabulary, default services, appointment statuses, custom booking fields,
// and deposit defaults. INTERNAL field names never change — barberId/cutNotes/
// chair stay as-is in the data model; profiles only relabel them in the UI.
//
// Adding a new vertical = a new block below. No other code changes required.

const INDUSTRIES = {
  barbershop: {
    label: 'Barbershop',
    vocab: {
      staff: 'Barber', staffPlural: 'Barbers', station: 'Chair',
      notes: 'Cut notes', bookCta: 'Book a haircut', yourStaff: 'Your barber',
    },
    services: [
      { name: 'Haircut',      category: 'cut',   price: 35, duration: 45 },
      { name: 'Fade',         category: 'cut',   price: 35, duration: 45 },
      { name: 'Beard Lineup', category: 'beard', price: 15, duration: 20 },
      { name: 'Kids Cut',     category: 'cut',   price: 25, duration: 30 },
    ],
    // `confirmed` = post-deposit/active, `terminal` = paid+counts toward revenue.
    statuses: [
      { key: 'confirmed',   label: 'Confirmed',   confirmed: true, occupiesSlot: true },
      { key: 'in-progress', label: 'In Progress',                  occupiesSlot: true },
      { key: 'done',        label: 'Done',        terminal: true },
      { key: 'no-show',     label: 'No Show',     noShow: true },
    ],
    customFields: [],
    supportsFleet: false,
    deposit: { enabled: false, amount: 10, message: 'A deposit is required to secure your appointment.' },
  },

  detail: {
    label: 'Detail Shop',
    vocab: {
      staff: 'Technician', staffPlural: 'Technicians', station: 'Bay',
      notes: 'Vehicle notes', bookCta: 'Book a service', yourStaff: 'Your technician',
    },
    // Placeholder defaults — owner edits these in Settings. Swap for the client's
    // real service menu once provided.
    services: [
      { name: 'Express Wash',        category: 'wash',   price: 40,  duration: 45 },
      { name: 'Interior Detail',     category: 'detail', price: 150, duration: 120 },
      { name: 'Full Detail',         category: 'detail', price: 250, duration: 180 },
      { name: 'Ceramic Coating',     category: 'coating', price: 600, duration: 300 },
    ],
    // NOTE: `confirmed`, `in-progress`, `done`, and `no-show` reuse the canonical
    // keys so existing revenue/loyalty/reminder logic works unchanged — only the
    // labels differ ("Completed" is the `done` key). The dropped-off/curing/ready
    // keys are new operational states with no business-logic meaning.
    statuses: [
      { key: 'confirmed',   label: 'Confirmed',           confirmed: true, occupiesSlot: true },
      { key: 'dropped-off', label: 'Vehicle Dropped Off', occupiesSlot: true },
      { key: 'in-progress', label: 'In Progress',         occupiesSlot: true },
      { key: 'curing',      label: 'Drying / Curing',     occupiesSlot: true },
      { key: 'ready',       label: 'Ready for Pickup' },
      { key: 'done',        label: 'Completed',           terminal: true },
      { key: 'no-show',     label: 'No Show',             noShow: true },
    ],
    customFields: [
      { key: 'vehicleYear',  label: 'Year',  type: 'text', required: true },
      { key: 'vehicleMake',  label: 'Make',  type: 'text', required: true },
      { key: 'vehicleModel', label: 'Model', type: 'text', required: true },
      { key: 'vehicleColor', label: 'Color', type: 'text', required: true },
    ],
    supportsFleet: true,
    deposit: { enabled: true, amount: 50, message: 'A $50 deposit is required to book your appointment.' },
  },

  nails: {
    label: 'Nail Studio',
    vocab: {
      staff: 'Nail Tech', staffPlural: 'Nail Techs', station: 'Station',
      notes: 'Service notes', bookCta: 'Book an appointment', yourStaff: 'Your nail tech',
    },
    services: [
      { name: 'Manicure',       category: 'nails', price: 30, duration: 45 },
      { name: 'Pedicure',       category: 'nails', price: 45, duration: 60 },
      { name: 'Gel Fill',       category: 'nails', price: 50, duration: 60 },
      { name: 'Full Set',       category: 'nails', price: 70, duration: 90 },
    ],
    statuses: [
      { key: 'confirmed',   label: 'Confirmed',   confirmed: true, occupiesSlot: true },
      { key: 'in-progress', label: 'In Progress',                  occupiesSlot: true },
      { key: 'done',        label: 'Done',        terminal: true },
      { key: 'no-show',     label: 'No Show',     noShow: true },
    ],
    customFields: [],
    supportsFleet: false,
    deposit: { enabled: true, amount: 25, message: 'A deposit is required to secure your appointment.' },
  },
};

const DEFAULT_INDUSTRY = 'barbershop';

// Shops created before this layer have no `industry` → fall back to barbershop
// so existing tenants render exactly as they did before.
function resolveProfile(industry) {
  return INDUSTRIES[industry] || INDUSTRIES[DEFAULT_INDUSTRY];
}

// Semantic status lookups so business logic (revenue, loyalty, no-show counts)
// is keyed on meaning, not a literal string that differs per vertical.
function terminalStatusKey(industry) {
  const p = resolveProfile(industry);
  return (p.statuses.find(s => s.terminal) || {}).key || 'done';
}
function confirmedStatusKey(industry) {
  const p = resolveProfile(industry);
  return (p.statuses.find(s => s.confirmed) || {}).key || 'confirmed';
}
function noShowStatusKey(industry) {
  const p = resolveProfile(industry);
  return (p.statuses.find(s => s.noShow) || {}).key || 'no-show';
}

module.exports = {
  INDUSTRIES, DEFAULT_INDUSTRY, resolveProfile,
  terminalStatusKey, confirmedStatusKey, noShowStatusKey,
};
