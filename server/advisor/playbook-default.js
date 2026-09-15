// Default Growth Advisor playbook — the operator's accumulated lessons and
// constraints, sent with every review. Editable from Admin → Settings →
// Growth Advisor (stored on master.platformSettings.advisorPlaybook); this
// text is only the starting value for a platform that has never saved one.
module.exports = `# ShopFlow Playbook

Keep entries short, factual, and dated. Add a lesson whenever a test settles.

## Constraints (never recommend these)
- Automated SMS is not available until A2P 10DLC registration is approved. Follow-up is manual texting from the owner's phone (ShopFlow prefills the message), phone calls, and email.
- Ad spend is paid by the shop, separate from the ShopFlow fee. Don't recommend budget increases without cost-per-booking data to back them.

## Proven lessons
- (Aug 2026, tint) Offer ads beat pain/hook ads on booked revenue, even though the hook ad had cheaper leads. Offer: $6.05 per lead, 3 bookings, $870 booked. Heat hook: $5.41 per lead, 0 bookings. Optimize for purchase-intent leads, not cheap leads.
  - Caveat: only 3 of 7 heat hook leads were contacted, so follow-up may have played a part.
- (Aug 2026, tint) Winning offer: free windshield strip with any full vehicle tint, value anchored at $100, deadline badge, real installer photo, "Claim Your Free Quote" call to action.
- (Sep 2026, tint) iPhone-shot video beat professionally shot video, same offer and audience: 2.73% CTR and $3.00 per lead vs 1.94% and $4.34. Retesting on car audio.

## How we work
- For managed clients, lead follow-up and booking is handled by the ShopFlow sales side, not the shop.
- Meta leads auto-enroll in the 30-day follow-up sequence in the shop's Tasks page; every send is a manual tap.
- Leads arrive from: landing-page quote forms (UTM-tagged), native Meta lead ads, phone calls (missed calls become leads), the AI receptionist, and manual adds.
`;
