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
    inspoDefault: 'off',
    // Barbershop clients usually pick their barber, so the booking staff step is on.
    staffPicker: true,
    serviceCategories: ['cut','beard','combo','color','design','other'],
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
    // Vehicle size classes for per-size service pricing. A service may carry a
    // `sizePricing` map ({sedan,suv,truck}); when present, the booked price is
    // chosen by the vehicle's size instead of the flat `price`.
    vehicleSizes: [
      { key: 'sedan', label: 'Sedan / Coupe' },
      { key: 'suv',   label: 'SUV / Crossover' },
      { key: 'truck', label: 'Truck / XL' },
    ],
    supportsFleet: true,
    deposit: { enabled: true, amount: 50, message: 'A $50 deposit is required to book your appointment.' },
    inspoDefault: 'off',
    // Detail customers rarely care which tech does the work — default the booking
    // staff step OFF (the owner can turn it back on in Settings for specialists).
    staffPicker: false,
    serviceCategories: ['wash','interior','exterior','detail','coating','tint','correction','other'],
    // Estimates/quotes are a detail-shop workflow (ceramic, PPF, correction).
    supportsQuotes: true,
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
    // Nail clients send a reference photo so the tech knows the look up front.
    inspoDefault: 'required',
    staffPicker: true,
    serviceCategories: ['manicure','pedicure','gel','acrylic','dip','art','other'],
  },

  cleaning: {
    label: 'Cleaning Company',
    vocab: {
      staff: 'Cleaner', staffPlural: 'Cleaners', station: 'Crew',
      notes: 'Job notes', bookCta: 'Request a cleaning', yourStaff: 'Your cleaner',
    },
    services: [
      { name: 'Standard Clean',  category: 'standard',  price: 120, duration: 120 },
      { name: 'Deep Clean',      category: 'deep',      price: 250, duration: 240 },
      { name: 'Move-Out Clean',  category: 'move',      price: 300, duration: 300 },
      { name: 'Recurring Weekly',category: 'recurring', price: 100, duration: 120 },
    ],
    // `en-route` is an operational state (crew on the way); canonical confirmed/
    // done/no-show keys are preserved so revenue/loyalty/reminder logic is unchanged.
    statuses: [
      { key: 'confirmed',   label: 'Scheduled',   confirmed: true, occupiesSlot: true },
      { key: 'en-route',    label: 'En Route',                     occupiesSlot: true },
      { key: 'in-progress', label: 'In Progress',                  occupiesSlot: true },
      { key: 'done',        label: 'Completed',   terminal: true },
      { key: 'no-show',     label: 'No Show',     noShow: true },
    ],
    // Address/size captured on the job now; promoted to a Properties module later
    // (see docs/v2/03-database-schema.md) without changing these field keys.
    customFields: [
      { key: 'serviceAddress', label: 'Service Address', type: 'text', required: true },
      { key: 'bedrooms',       label: 'Bedrooms',        type: 'text' },
      { key: 'bathrooms',      label: 'Bathrooms',       type: 'text' },
    ],
    supportsFleet: false,
    deposit: { enabled: false, amount: 25, message: 'A deposit is required to secure your booking.' },
    inspoDefault: 'off',
    // The office assigns a crew; clients don't pick an individual cleaner.
    staffPicker: false,
    serviceCategories: ['standard','deep','move','recurring','commercial','other'],
    supportsQuotes: true,
  },

  tint: {
    label: 'Tint Shop',
    vocab: {
      staff: 'Installer', staffPlural: 'Installers', station: 'Bay',
      notes: 'Vehicle notes', bookCta: 'Book a tint', yourStaff: 'Your installer',
    },
    services: [
      { name: 'Front Two Windows', category: 'tint',    price: 80,  duration: 60 },
      { name: 'Full Vehicle Tint', category: 'tint',    price: 250, duration: 180 },
      { name: 'Ceramic Full Tint', category: 'ceramic', price: 400, duration: 210 },
      { name: 'Tint Removal',      category: 'removal',  price: 120, duration: 90 },
    ],
    // Reuses the detail-shop operational flow (curing/ready) and canonical keys.
    statuses: [
      { key: 'confirmed',   label: 'Confirmed',           confirmed: true, occupiesSlot: true },
      { key: 'dropped-off', label: 'Vehicle Dropped Off', occupiesSlot: true },
      { key: 'in-progress', label: 'In Progress',         occupiesSlot: true },
      { key: 'curing',      label: 'Curing',              occupiesSlot: true },
      { key: 'ready',       label: 'Ready for Pickup' },
      { key: 'done',        label: 'Completed',           terminal: true },
      { key: 'no-show',     label: 'No Show',             noShow: true },
    ],
    customFields: [
      { key: 'vehicleYear',  label: 'Year',  type: 'text', required: true },
      { key: 'vehicleMake',  label: 'Make',  type: 'text', required: true },
      { key: 'vehicleModel', label: 'Model', type: 'text', required: true },
      { key: 'vehicleColor', label: 'Color', type: 'text' },
    ],
    vehicleSizes: [
      { key: 'sedan', label: 'Sedan / Coupe' },
      { key: 'suv',   label: 'SUV / Crossover' },
      { key: 'truck', label: 'Truck / XL' },
    ],
    supportsFleet: true,
    deposit: { enabled: true, amount: 50, message: 'A $50 deposit is required to book your appointment.' },
    inspoDefault: 'off',
    staffPicker: false,
    serviceCategories: ['tint','ceramic','removal','windshield','other'],
    supportsQuotes: true,
  },

  pressure: {
    label: 'Pressure Washing',
    vocab: {
      staff: 'Technician', staffPlural: 'Technicians', station: 'Crew',
      notes: 'Job notes', bookCta: 'Request a quote', yourStaff: 'Your technician',
    },
    services: [
      { name: 'Driveway Wash',     category: 'driveway',   price: 120, duration: 60 },
      { name: 'House Soft Wash',   category: 'house',      price: 300, duration: 180 },
      { name: 'Deck / Patio Wash', category: 'deck',       price: 200, duration: 120 },
      { name: 'Commercial Flatwork',category: 'commercial',price: 500, duration: 240 },
    ],
    statuses: [
      { key: 'confirmed',   label: 'Scheduled',   confirmed: true, occupiesSlot: true },
      { key: 'en-route',    label: 'En Route',                     occupiesSlot: true },
      { key: 'in-progress', label: 'In Progress',                  occupiesSlot: true },
      { key: 'done',        label: 'Completed',   terminal: true },
      { key: 'no-show',     label: 'No Show',     noShow: true },
    ],
    customFields: [
      { key: 'serviceAddress', label: 'Service Address', type: 'text', required: true },
      { key: 'surfaceType',    label: 'Surface Type',    type: 'text' },
    ],
    supportsFleet: false,
    deposit: { enabled: false, amount: 25, message: 'A deposit is required to secure your booking.' },
    inspoDefault: 'off',
    staffPicker: false,
    serviceCategories: ['driveway','house','deck','roof','commercial','other'],
    supportsQuotes: true,
  },

  other: {
    label: 'Other Service Business',
    vocab: {
      staff: 'Team Member', staffPlural: 'Team', station: 'Station',
      notes: 'Notes', bookCta: 'Book an appointment', yourStaff: 'Your specialist',
    },
    services: [
      { name: 'Consultation',    category: 'service', price: 50,  duration: 30 },
      { name: 'Standard Service',category: 'service', price: 100, duration: 60 },
    ],
    statuses: [
      { key: 'confirmed',   label: 'Confirmed',   confirmed: true, occupiesSlot: true },
      { key: 'in-progress', label: 'In Progress',                  occupiesSlot: true },
      { key: 'done',        label: 'Done',        terminal: true },
      { key: 'no-show',     label: 'No Show',     noShow: true },
    ],
    customFields: [],
    supportsFleet: false,
    deposit: { enabled: false, amount: 10, message: 'A deposit is required to secure your appointment.' },
    inspoDefault: 'off',
    staffPicker: true,
    serviceCategories: ['service','other'],
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
