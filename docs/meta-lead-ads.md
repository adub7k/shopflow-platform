# Native Meta Lead Ads ingestion

Meta posts leadgen notifications straight to ShopFlow — no Make.com, no Zapier.
Leads land in the same place website leads do (`leads-core.upsertLead`), so they
get the same phone dedupe, the same owner email + push, and the same Pipeline row.

- Handler: `server/routes/meta-webhook.js`
- Raw-body capture: `server/index.js` (the `verify` hook on `express.json`)
- Test: `node test/meta-webhook.test.js`

---

## 1. Railway environment variables

| Variable | Required | What it is |
|---|---|---|
| `META_VERIFY_TOKEN` | **yes** | Any random string you invent. You type the *same* string into the Meta dashboard when you save the webhook URL. Only used for the one-time handshake. |
| `META_APP_SECRET` | **yes** | Meta app's **App Secret** — App Dashboard → Settings → Basic → App Secret → *Show*. Used to verify every inbound POST. |
| `META_PAGE_ACCESS_TOKEN` | optional | Global fallback long-lived page token. Fine while one shop runs lead ads; per-shop `metaPageToken` beats it when set. |
| `META_GRAPH_VERSION` | optional | Defaults to `v19.0`. Only set this to pin a different Graph version. |

Generate a verify token:

```bash
openssl rand -hex 24
```

**Without `META_APP_SECRET` set, every webhook POST is rejected with 403** and the
log says so — that's deliberate, an unverified webhook is an open lead-injection
endpoint.

## 2. Per-shop config

Two fields on the master shop record (`data/master.json` → `shops[]`), same place
as `twilioFromNumber`:

- `metaPageId` — the Facebook Page id. Routes an inbound `page_id` to the tenant.
- `metaPageToken` — that page's long-lived access token (optional if
  `META_PAGE_ACCESS_TOKEN` covers it).

Set them from the admin API:

```bash
curl -X PATCH https://shopflowio.up.railway.app/api/admin/shop/<SHOP_ID> \
  -H "x-admin-key: $ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"metaPageId":"102938475600","metaPageToken":"EAAG..."}'
```

If a lead arrives for a page id no shop claims, the lead is **not** saved and the
log prints the unmatched page id and what to do about it. Nothing throws.

## 3. Fake a webhook locally (no Facebook needed)

Runs against a local server. Signs the body exactly the way Meta does, so it
exercises the real signature check.

```bash
BODY='{"object":"page","entry":[{"id":"102938475600","time":1755700000,"changes":[{"field":"leadgen","value":{"leadgen_id":"TEST_LEAD_1","page_id":"102938475600","form_id":"FORM_1","ad_id":"AD_1","created_time":1755700000}}]}]}'; SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$META_APP_SECRET" | sed 's/^.* //')"; curl -i -X POST http://localhost:3000/webhooks/meta -H 'content-type: application/json' -H "X-Hub-Signature-256: $SIG" -d "$BODY"
```

Expect `200` immediately. The interesting part is the log:

```
[meta-webhook] inbound POST — 222 bytes, signature present
[meta-webhook] payload: 1 entry, 1 leadgen change(s)
[meta-webhook] matched tenant shop=… page=102938475600 leadgen_id=TEST_LEAD_1
[meta-webhook] fetched leadgen_id=TEST_LEAD_1 fields=[full_name, phone_number, email]
[meta-webhook] saved lead=lead… NEW notified=true name="…" phone="…"
```

Note the Graph call is **real** — a made-up `leadgen_id` will fail with
`GRAPH FETCH FAILED … Graph 400`. That still proves signature + routing + token
are correct. To exercise the whole chain offline with a stubbed Graph API, run
`node test/meta-webhook.test.js`.

Test the handshake the same way Meta will:

```bash
curl -i "http://localhost:3000/webhooks/meta?hub.mode=subscribe&hub.verify_token=$META_VERIFY_TOKEN&hub.challenge=12345"
```

Expect `200` with body `12345` and nothing else.

## 4. Meta dashboard checklist

Do these in order — the token step depends on the Leads Access step.

### A. App setup — developers.facebook.com → your app

1. **Add the Webhooks product** (left sidebar → *Add Product* → Webhooks).
2. Webhooks → **Page** in the dropdown → **Subscribe to this object**.
3. Callback URL: `https://shopflowtech.com/webhooks/meta`
   Verify Token: the value of `META_VERIFY_TOKEN`.
   Click **Verify and Save** — this fires the GET handshake. If it fails, the
   env var isn't set on Railway or the deploy hasn't picked it up yet.
4. In the Page subscriptions list, find **`leadgen`** and click **Subscribe**.
   This is the field that actually delivers leads — subscribing to the Page
   object alone delivers nothing.
5. Settings → Basic → copy the **App Secret** into `META_APP_SECRET`.
6. **Add the Facebook Login for Business product** if it isn't there — the
   token step needs it.

### B. Business Settings — business.facebook.com

7. **Business Settings → Accounts → Pages → [the shop's page] → Add People /
   Add Assets** — make sure your business owns the page.
8. **Business Settings → Integrations → Leads Access** → select the page →
   **Assign** your app (and your user) **Leads Access**. Without this the Graph
   call returns a permissions error even with a valid token, and it's the single
   most common reason this setup fails silently.

### C. Long-lived page access token

9. Open **Graph API Explorer** (developers.facebook.com/tools/explorer).
10. Pick your app, then **User Token**, and request these permissions:
    `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`,
    `leads_retrieval`, `business_management`.
11. **Generate Access Token** and approve the dialog. This gives a *short-lived
    user* token — not what you want yet.
12. Exchange it for a long-lived user token:

    ```bash
    curl -G https://graph.facebook.com/v19.0/oauth/access_token \
      -d grant_type=fb_exchange_token \
      -d client_id=<APP_ID> \
      -d client_secret=<APP_SECRET> \
      -d fb_exchange_token=<SHORT_LIVED_USER_TOKEN>
    ```

13. Trade that for the **page** token — page tokens derived from a long-lived
    user token do not expire:

    ```bash
    curl -G https://graph.facebook.com/v19.0/me/accounts \
      -d access_token=<LONG_LIVED_USER_TOKEN>
    ```

    Find the shop's page in the response; its `access_token` is the long-lived
    page token, and its `id` is the `metaPageId`.
14. Verify it never expires — `expires_at` should be `0`:

    ```bash
    curl -G https://graph.facebook.com/debug_token \
      -d input_token=<PAGE_TOKEN> \
      -d access_token=<APP_ID>|<APP_SECRET>
    ```

15. Save both values onto the shop record (section 2).

### D. Access tier — how far this works without App Review

16. **Pages you personally admin need no App Review.** Meta's *Standard Access*
    covers any Page admin'd by someone who holds a role on the app (Admin /
    Developer / Tester), and it's granted automatically. The app can stay in
    **Development mode**. This is the current setup — `leads_retrieval` works
    today. (The Leads Access assignment in step 8 is still required, and is the
    step that fails silently.)
17. **A client's Page you don't admin** needs one of:
    - **Add that owner as a Tester** (App Dashboard → Roles → Testers). They
      accept the invite, and their Page falls under Standard Access. Free,
      instant, no review — the right answer for the first handful of shops.
    - **App Review** for `leads_retrieval` (+ `pages_show_list`,
      `pages_read_engagement`), the app switched to **Live**, and most likely
      **Business Verification** (legal entity docs for the LLC). Days to weeks.
      This is the answer at volume, not before.
18. Test end-to-end without spending ad budget: **Lead Ads Testing Tool**
    (developers.facebook.com/tools/lead-ads-testing) → pick the page and form →
    **Create Lead**. A real webhook fires with a real, fetchable `leadgen_id`.
    This is also the fastest way to confirm which access tier you're actually
    getting — Meta changes these rules, the tool tells you the truth.

---

## Behaviour notes

- **Idempotent.** `metaLeadgenId` is stored on the lead. A re-delivery is skipped
  before the Graph call is made. An in-memory guard covers the burst case where
  the duplicate lands before the first write.
- **Fields are mapped by name, never by index.** Reordering fields in the Instant
  Form cannot silently move a phone number into the email column. Anything that
  isn't a contact field is kept in `metaCustomFields` and folded into the lead's
  notes so the owner reads the answers in the CRM.
- **No SMS.** This path fires the owner email + mobile push only, same as the
  website form — nothing here depends on A2P 10DLC. Both sends are
  fire-and-forget inside `leads-core`; a failing send cannot lose a lead.
- **No App Review needed for pages you admin** — see §4D. Review only becomes
  necessary for a client's page you have no role on.
- **Always ACKs 200 after signature verification.** Meta disables webhooks that
  respond slowly or fail. Unknown page, dead token, Graph error: all logged, none
  fatal, all still 200.
