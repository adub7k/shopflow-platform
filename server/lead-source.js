// Raw lead/customer source string → one reporting bucket ({ key, label }).
// Shared by the shop Revenue tab (bookings by lead source) and the admin
// "What we booked" report so both name channels the same way.
function bucketLeadSource(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s || ['seed', 'crm', 'manual', 'estimate', 'direct'].includes(s)) return { key: 'direct', label: 'Direct / manual' };
  if (/\b(meta|facebook|fb|instagram|ig)\b/.test(s))                    return { key: 'meta', label: 'Meta ads' };
  if (/\b(google|gmb|lsa|maps)\b/.test(s))                              return { key: 'google', label: 'Google' };
  if (/\b(call|phone|missed|voicemail|receptionist|ai-voice)\b/.test(s)) return { key: 'call', label: 'Phone call' };
  if (/\b(booking-page|booking|online)\b/.test(s))                      return { key: 'online', label: 'Online booking' };
  if (/\b(website|web|form|landing)\b/.test(s))                         return { key: 'website', label: 'Website' };
  if (/\breferral\b/.test(s))                                            return { key: 'referral', label: 'Referral' };
  if (/\bwalk/.test(s))                                                   return { key: 'walk-in', label: 'Walk-in' };
  return { key: s.slice(0, 30), label: s.charAt(0).toUpperCase() + s.slice(1, 30) };
}

module.exports = { bucketLeadSource };
