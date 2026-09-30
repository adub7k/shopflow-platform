# shopflowtech.com — rebuild + SEO plan

Handoff for Claude Code. Everything in this folder is drop-in static; the Express changes are in section 2.

## 1. What's in this folder

| File | What it is |
|---|---|
| `index.html` | Rebuilt homepage. 30-day numbers from the Sept one-pager, full SEO head, JSON-LD (ProfessionalService + Person + WebSite + FAQPage). |
| `css/site.css` | One stylesheet for every page. Fonts: Archivo (display) + IBM Plex Sans (body) via Google Fonts. |
| `guides/index.html` | Guides hub. Lists the live guide + five planned ones (section 5). |
| `guides/how-to-grow-a-window-tinting-business/index.html` | Pillar article, ~2,600 words, Article + FAQPage + Breadcrumb schema. |
| `sitemap.xml`, `robots.txt` | Currently both URLs return the homepage HTML (see section 2). |

Keep from the existing site: `/icons/`, `/img/marketing/*.png`, `terms.html`, `privacy.html`, `/login`, `/demo`, and the app routes.

## 2. Express fixes (do these first — they're the biggest ranking problem right now)

`https://shopflowtech.com/sitemap.xml` and `/robots.txt` both serve the homepage HTML. Googlebot reads that as "no sitemap, no robots," and any URL it guesses returns a soft 200 with duplicate homepage content. Fix:

```js
// BEFORE any catch-all / SPA fallback:
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],          // /guides/ → guides/index.html
  index: 'index.html',
  maxAge: '7d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// Explicit, in case something upstream shadows static:
app.get('/sitemap.xml', (req, res) => res.type('application/xml').sendFile(path.join(__dirname, 'public/sitemap.xml')));
app.get('/robots.txt',  (req, res) => res.type('text/plain').sendFile(path.join(__dirname, 'public/robots.txt')));

// Trailing-slash canonical for guide folders (avoid /guides and /guides/ both indexing):
app.use((req, res, next) => {
  if (req.path.startsWith('/guides') && !req.path.endsWith('/') && !path.extname(req.path)) {
    return res.redirect(301, req.path + '/' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''));
  }
  next();
});

// Real 404 for unknown marketing URLs. Do NOT fall through to index.html for everything.
// If a SPA fallback is needed for the app, scope it: app.get(['/app', '/app/*'], ...)
app.use((req, res) => res.status(404).send('Not found'));
```

Also:
- Force one host: 301 `www.shopflowtech.com` → `shopflowtech.com` (or the reverse; canonicals in the HTML assume no-www).
- Force https (Railway usually does; verify `http://` 301s).
- `Content-Type: text/html; charset=utf-8` on HTML (Express does this by default with static).
- Compression: `app.use(require('compression')())` if not already there.

## 3. Image assets to create

- `img/og-home.png` — 1200×630. Pine background, "$25.06 per booked job." big, the four funnel bars underneath. Referenced in homepage + guides hub OG tags.
- `img/og-grow-tint.png` — 1200×630. Same style, headline "How to grow a window tinting business", the 276 / 261 / 54 / 18 funnel.
- Optional for the homepage ledger section: the Ads Manager screenshot for Aug 18–Sep 16 (like the existing `img/marketing/tint-ads-results.png` but for the 30-day window). Add as `<figure class="shot">` under the ledger table if you want the receipt on the page.

## 4. Search Console + analytics (one-time, ~20 min)

1. Google Search Console → add `shopflowtech.com` as a Domain property (DNS TXT record). Submit `https://shopflowtech.com/sitemap.xml`.
2. Request indexing on the three pages manually (URL inspection → Request indexing). New domain, one page indexed today — don't wait for the crawl.
3. Bing Webmaster Tools → import from GSC. Two minutes, and Bing/DuckDuckGo/ChatGPT search all pull from it.
4. GA4 or Plausible; either is fine. Tag the `/demo` click as a conversion.
5. Google Business Profile for ShopFlow Technologies LLC, category "Marketing agency", Albuquerque. It's a B2B service but shop owners search "marketing agency albuquerque" and the map pack is free.

## 5. Keyword map and publishing calendar

Honest framing first: "how to grow a tinting business" and its cousins are **low-volume** queries — tens to low hundreds of US searches a month each. That is the point. The people searching them are exactly tint/PPF/detail shop owners, and the current results are thin listicles from hosting companies and software vendors (HostPapa, Tint Wiz, ExoShield, Servgrow, TRUiC) that have never run a campaign. A guide with real numbers beats them on quality; it will still take **3–6 months and some links** to beat them on authority, because shopflowtech.com is a brand-new domain with one indexed page.

The ranking strategy is: one pillar per vertical, five to six supporting guides per pillar, every guide built on a real campaign teardown, and every guide internally linked to the pillar and the homepage.

### Pillar 1 — window tint (LIVE)
Target: `how to grow a window tinting business` · `how to grow a tint business` · `window tint shop marketing` · `how to get more window tint customers` · `window tinting business tips`
URL: `/guides/how-to-grow-a-window-tinting-business/`

Supporting (in publish order, one every 2 weeks):

| # | Working title | Primary query | Data you already have |
|---|---|---|---|
| 1 | Facebook ads for window tint shops: offer vs heat hook, with the numbers | `facebook ads for window tinting` · `window tint ads` | Aug test: Offer $6.32 CPL / 3 booked vs Heat $5.10 / 0; six-creative Ads Manager table; CPL curve after new creative |
| 2 | Google Ads for tint shops: rebuilding a $25/day campaign | `google ads for window tinting` · `window tinting ppc` | 28-day search-term table; PMax discovery; one-campaign-per-service; $40/day exact-match rebuild |
| 3 | How to get ceramic coating customers | `how to get ceramic coating customers` · `ceramic coating marketing` · `ceramic coating leads` | 35 clicks / $270 / 1 lead → $2,000 job; organic ceramic page leads |
| 4 | PPF marketing: what customers actually search | `ppf marketing` · `how to get ppf customers` · `paint protection film marketing` | PPF ad group inside ceramic campaign; "clear bra" language |
| 5 | Speed to lead for auto shops | `speed to lead` · `missed call text back auto shop` · `lead follow up for auto detailing` | 261/276 reached; 3-attempt cadence; 12 no-response → 4th booking after cadence |
| 6 | Window tint pricing: should you put your price in the ad? | `window tint pricing strategy` · `how much to charge for window tint` | $250 → $475 starting price; front-two dragging ticket; $199 budget tier at ~53% GM |

### Pillar 2 — auto detailing (Q4)
Target: `how to grow a detailing business` · `how to get more auto detailing customers` · `auto detailing marketing` · `car detailing advertising ideas`
Higher volume than tint (Jobber, Chuckwalla, Symphony already rank). Write it after the audio-shop and next detailing client give you a second set of numbers, so it isn't the tint case study with the nouns swapped.

### Pillar 3 — the "leads die" angle (Q4)
Target: `why am i not converting leads auto shop` · `how to answer the phone at a body shop / tint shop` · `auto shop missed calls`
Low volume, zero competition, and it's your actual positioning.

### Local / commercial pages (for the sales side, not the guide side)
- `/window-tint-marketing-albuquerque/` — "Marketing for tint shops in Albuquerque"; thin now, matters when you expand to Phoenix/El Paso and clone it per city.
- `/case-study/` — move the 30-day ledger to its own URL with the one-pager PDF linked. Sales asset with a permalink.

### Every guide gets
- Title ≤ 60 chars with the query near the front; description ≤ 155 chars with a number in it.
- `Article` + `FAQPage` + `BreadcrumbList` JSON-LD (copy from the live guide).
- A "short answer" box at the top (featured snippet / AI Overview bait).
- At least one table of real numbers. This is the moat — nobody else in the SERP has a table.
- Link to the pillar, the homepage `#numbers` section, and `/demo`.
- Byline "Aidan Woods" + the author block. Google's E-E-A-T scoring is literally "did a person with experience write this."
- Add the URL to `sitemap.xml` with today's `lastmod`.

## 6. Links (the part content can't do alone)

New domain, so nothing ranks on content alone for a while. Cheapest real links, in order:

1. **Client sites.** "Marketing by ShopFlow" in the footer of evosolution.org and the audio shop's site, linking to shopflowtech.com. Two links from real local businesses in the exact niche.
2. **Film manufacturer dealer pages / blogs.** ExoShield, XPEL, Llumar and the like run partner blogs ("How to grow your tinting business" on getexoshield.com is one of the current top results). Pitch the offer-vs-heat-hook test as a guest post. They want content for dealers; you have data.
3. **Tint / detailing forums and Facebook groups.** Post the guide where owners actually hang out (Detailing World, r/AutoDetailing, r/WindowTint, the big tint-installer FB groups). Not spam: post the numbers, answer questions, link once.
4. **Local.** Albuquerque Journal / Albuquerque Business First small-business stories; UNM / CNM entrepreneurship features; NM Chamber directory. A 21-year-old founder with real numbers is a story.
5. **Podcasts.** Detailing/tint industry podcasts take guests constantly. One episode = one link + an audience.
6. **Your own TikTok/IG teardowns** → link in bio → guide. Doesn't pass much authority but drives the traffic that makes Google trust the page.

Skip: paid directories, "SEO packages," anything that offers 50 links for $99.

## 7. What "ranking high" realistically looks like

- Month 1: three pages indexed, impressions in GSC for brand + a few long-tail queries.
- Month 2–3: page 2–3 for `how to grow a window tinting business` and variants; page 1 for a couple of zero-competition phrases (`offer vs heat hook`, `speed to lead tint shop`).
- Month 4–6, with 4–6 guides and 5–10 real links: page 1 for the tint pillar cluster; guides start showing in AI Overviews because they have tables and a short-answer block.
- Traffic won't be big. 200–500 visits/month across the guides is a good outcome. What matters is that a meaningful share of those are tint/PPF/detail owners, and the pillar → `#numbers` → `/demo` path converts a few of them.

Check monthly: GSC queries + positions per guide, `/demo` clicks by landing page, and which guide the last three booked calls read.
