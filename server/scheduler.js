const { master, getShopDb, shopHelpers, shopFromNumber, buildSms, twilioClient, TWILIO_DEFAULT_FROM } = require('./db');

// ── Scheduler: 24hr reminders + 21-day rebook nudges ─────────────────────────
async function runScheduler() {
  try {
    const shops = master.get('shops').value().filter(s => s.active);
    for (const shop of shops) {
      try {
        const fromNum = shopFromNumber(shop.id);
        if (!twilioClient || !fromNum) continue;  // skip shops without SMS configured
        const db = getShopDb(shop.id);
        const s = db.get('settings').value()||{};

        // ── 24hr appointment reminders ──
        const tomorrow = new Date(Date.now()+24*3600000).toISOString().split('T')[0];
        const appts = db.get('appointments').value().filter(a=>a.date===tomorrow&&a.status==='confirmed');
        const sentIds = s.remindersSent||[];
        const toRemind = appts.filter(a=>!sentIds.includes(a.id)&&a.customerPhone);
        for (const appt of toRemind) {
          const phone = (appt.customerPhone||'').replace(/[^0-9]/g,'');
          if (phone.length<10) continue;
          const msg = buildSms('reminder', { name:(appt.customerName||'').split(' ')[0], shop:s.shopName, time:appt.time, barber:appt.barberName }, s);
          try { await twilioClient.messages.create({from:fromNum,to:'+1'+phone,body:msg}); sentIds.push(appt.id); } catch(e){}
        }
        if (toRemind.length) db.get('settings').assign({ remindersSent:sentIds.slice(-500) }).write();

        // ── Rebook nudges (interval set per shop, default 21 days) ──
        const rebookDays = Math.min(90, Math.max(7, s.rebookInterval || 21));
        const nudgeSentIds = s.nudgesSent||[];
        const cutoffDate = new Date(Date.now()-rebookDays*24*3600000).toISOString().split('T')[0];
        // Find each customer's most recent completed appointment
        const allAppts = db.get('appointments').value().filter(a=>a.status==='done');
        const lastVisit = {};
        allAppts.forEach(a=>{ if(!lastVisit[a.customerId]||a.date>lastVisit[a.customerId].date) lastVisit[a.customerId]={date:a.date,name:a.customerName,phone:a.customerPhone}; });
        // Anyone whose last visit was rebookDays+ ago and hasn't been nudged yet
        const toNudge = Object.values(lastVisit).filter(v=>v.date<=cutoffDate&&v.phone);
        for (const v of toNudge) {
          const nudgeKey = v.phone+':'+v.date;
          if (nudgeSentIds.includes(nudgeKey)) continue;
          const phone = (v.phone||'').replace(/[^0-9]/g,'');
          if (phone.length<10) continue;
          const firstName = (v.name||'').split(' ')[0]||'there';
          const msg = buildSms('rebook', { name:firstName, shop:s.shopName }, s);
          try { await twilioClient.messages.create({from:fromNum,to:'+1'+phone,body:msg}); nudgeSentIds.push(nudgeKey); } catch(e){}
        }
        db.get('settings').assign({ nudgesSent:nudgeSentIds.slice(-1000) }).write();

      } catch(e) {}
    }
  } catch(e) { console.error('Scheduler error:', e.message); }
}
setInterval(runScheduler, 5*60*1000);

module.exports = { runScheduler };
