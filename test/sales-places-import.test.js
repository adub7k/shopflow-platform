// Integration test for the admin "Import shops from Google Maps" panel, which
// runs Apify's Google Maps Scraper: POST /api/admin/sales/import-places/start,
// GET …/status, POST …/apply. Apify is stubbed. Checks the run is started with
// hard billing caps and no paid add-ons, the preview dedupes shops found by two
// searches and skips closed / off-topic / out-of-metro places, shops already in
// the pipeline are matched by name and only get blanks filled, new shops land
// as "not-contacted" with a pin, apply re-reads the dataset (no new scrape),
// and a later form edit keeps the imported extras (website / rating / placeId).
// Run: node test/sales-places-import.test.js
const path = require('path');
const os = require('os');
process.env.DATA_DIR = path.join(os.tmpdir(), 'sf-places-' + process.pid);
process.env.APIFY_TOKEN = 'test-token';

const express = require('express');
const { master } = require('../server/db');

let failures = 0;
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`); };

const item = (placeId, title, extra = {}) => ({
  placeId, title, address: `${placeId} Central Ave SE, Albuquerque, NM 87106, USA`, city: 'Albuquerque',
  location: { lat: 35.08, lng: -106.61 }, phone: '(505) 555-0100', website: 'https://' + placeId + '.example',
  totalScore: 4.8, reviewsCount: 120, permanentlyClosed: false, categoryName: 'Car detailing service',
  categories: ['Car detailing service'], searchString: 'car window tinting', ...extra,
});
const ITEMS = [
  item('p1', 'Duke City Detail'),
  item('p1', 'Duke City Detail', { searchString: 'car wrap' }),                                  // same shop, second search
  item('p2', 'Tint Pros'),                                                                        // already in the pipeline
  item('p3', 'Old Shine Co', { permanentlyClosed: true }),
  item('p4', 'Big Lot Motors', { categoryName: 'Used car dealer', categories: ['Used car dealer'] }),
  item('p5', 'Santa Fe Tint', { location: { lat: 35.69, lng: -105.94 } }),                        // outside the metro
];

// Stub Apify.
let runStatus = 'RUNNING', started = null, datasetReads = 0;
const realFetch = global.fetch;
global.fetch = (url, opts = {}) => {
  url = String(url);
  if (!url.startsWith('https://api.apify.com/')) return realFetch(url, opts);
  if (opts.headers.Authorization !== 'Bearer test-token') throw new Error('missing token');
  const json = body => Promise.resolve({ ok: true, json: async () => body });
  if (url.includes('/acts/compass~crawler-google-places/runs')) {
    started = { url, input: JSON.parse(opts.body) };
    return json({ data: { id: 'run1', defaultDatasetId: 'ds1', status: 'READY' } });
  }
  if (url.endsWith('/actor-runs/run1')) return json({ data: { status: runStatus, finishedAt: runStatus === 'SUCCEEDED' ? new Date().toISOString() : null } });
  if (url.endsWith('/datasets/ds1')) return json({ data: { itemCount: 2 } });
  if (url.includes('/datasets/ds1/items')) { datasetReads++; return json(url.includes('offset=0') ? ITEMS : []); }
  throw new Error('unexpected Apify call ' + url);
};

const app = express();
app.use(express.json());
app.use(require('../server/routes/sales'));
const server = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = { 'content-type': 'application/json', 'x-admin-key': 'shopflow-admin' };
  const post = (p, body) => realFetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body || {}) }).then(r => r.json());
  const get = p => realFetch(base + p, { headers: H }).then(r => r.json());

  await get('/api/admin/sales');   // creates the sales blob
  await post('/api/admin/sales/leads', { name: 'Tint Pros', status: 'demo', notes: 'demo Tuesday' });

  const st = await post('/api/admin/sales/import-places/start', { kinds: ['tint'], maxPlaces: 300 });
  eq('start ok + running', [st.ok, st.run.status, st.run.scraped], [true, 'RUNNING', 2]);
  eq('billing caps on the run', [/maxItems=300\b/.test(started.url), /maxTotalChargeUsd=1.25\b/.test(started.url)], [true, true]);
  eq('tint search terms, split budget', [started.input.searchStringsArray, started.input.maxCrawledPlacesPerSearch], [['car window tinting', 'car wrap', 'paint protection film'], 100]);
  eq('no paid add-ons', [started.input.skipClosedPlaces, started.input.scrapePlaceDetailPage, started.input.scrapeContacts, started.input.maxReviews, started.input.maxImages], [false, false, false, 0, 0]);
  eq('second start refused while running', (await post('/api/admin/sales/import-places/start', { kinds: ['tint'] })).ok, false);
  eq('apply refused while running', (await post('/api/admin/sales/import-places/apply')).ok, false);

  runStatus = 'SUCCEEDED';
  const s = (await get('/api/admin/sales/import-places/status')).run;
  eq('preview: 1 new, 1 already have', [s.status, s.scraped, s.found, s.wouldAdd, s.alreadyHave], ['SUCCEEDED', 6, 2, 1, 1]);
  eq('preview skipped closed / dealer / outside', s.skipped, { closed: 1, offTopic: 1, outside: 1 });
  eq('preview saves nothing', master.get('sales.leads').value().length, 1);
  eq('shop found by two searches → one lead, one label', s.sample, [{ name: 'Duke City Detail', city: 'Albuquerque', category: 'Tint & wrap', rating: 4.8, reviews: 120 }]);

  const startsBefore = started; datasetReads = 0;
  const run = await post('/api/admin/sales/import-places/apply');
  eq('apply reads the dataset, no new scrape', [started === startsBefore, datasetReads], [true, 1]);
  eq('apply adds 1, enriches 1', [run.added, run.enriched], [1, 1]);
  const leads = master.get('sales.leads').value();
  const duke = leads.find(l => l.name === 'Duke City Detail');
  eq('new shop is not-contacted + pinned', [duke.status, duke.lat, duke.lng, duke.city, duke.contact, duke.source], ['not-contacted', 35.08, -106.61, 'Albuquerque', '(505) 555-0100', 'google-maps']);
  const tp = leads.find(l => l.name === 'Tint Pros');
  eq('existing shop keeps stage + notes, gets pin', [tp.status, tp.notes, tp.lat != null, tp.placeId], ['demo', 'demo Tuesday', true, 'p2']);
  eq('totals leave the cold list out', [run.totals.leads, run.totals.prospects], [1, 1]);

  // A rep-style edit (no pin / website fields sent) must keep the imported extras.
  await post('/api/admin/sales/leads', { id: duke.id, name: duke.name, status: 'contacted' });
  const after = master.get('sales.leads').find({ id: duke.id }).value();
  eq('edit keeps website/rating/placeId/pin', [after.status, after.website, after.rating, after.placeId, after.lat], ['contacted', 'https://p1.example', 4.8, 'p1', 35.08]);

  const again = (await get('/api/admin/sales/import-places/status')).run;
  eq('reopening shows nothing new, marked imported', [again.wouldAdd, again.alreadyHave, !!again.appliedAt], [0, 2, true]);

  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
});
