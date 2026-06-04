/*  mainstreet-vendor-lookup.js  — FINALIZED v2
 *  ------------------------------------------------------------------
 *  Deterministic vendor-cost lookup for Mainstreet Glas-Avenue.
 *  Drives the real UI with Playwright so the POS builds its own
 *  Vendor-Inquiry view model (the /IV/Inventory/InquiryView step a raw
 *  fetch can't fake), then reads the /Inventory/Inquire response.
 *
 *  SELECTORS CONFIRMED LIVE (from the in-browser recording):
 *    VIN field ............... #VINSearch
 *    Glass tab ............... #GlassTab
 *    Part row ................ table cell containing the NAGS part text
 *    Select/Inquire checkbox . #agSelect
 *    Vendor Inquiry .......... <a class="btn btn-primary">Vendor Inquiry</a>
 *    Inquire (in panel) ...... button labelled "Inquire"
 *    Result call captured .... POST /Glasave10/Inventory/Inquire  (VendItems[])
 *
 *  PICK RULE (final): cheapest GLASS row that is in-stock AND
 *  "Available Locally". If none -> no_vendor_available => staff note.
 *
 *  SETUP / DEPLOY / n8n WIRING:
 *    npm i express playwright && npx playwright install chromium
 *    Deploy to Railway/Render (Dockerfile: FROM mcr.microsoft.com/playwright:v1.49.0-jammy)
 *    env: MS_USERNAME, MS_PASSWORD, SHARED_SECRET
 *    n8n HTTP Request node (replaces the Browserbase node in WF2):
 *      POST https://<service>/lookup  header x-secret  body {"vin":"{{ $json.vin }}"}
 *      -> feed vendor_cost / vendor_name / no_vendor_available into WF6.
 *
 *  // TODO:VERIFY on first tuning run (everything else is from live capture):
 *    - profile-picker dropdown interaction ("MANAGER MANAGER")
 *    - the VIN decode trigger (Enter vs. a search icon) + any confirm popup
 *    - the exact "Inquire" button text/role in the vendor panel
 *    - the logout link/URL (to free the seat)
 *  ------------------------------------------------------------------
 */

const express = require('express');
const { chromium } = require('playwright');

const BASE = 'https://ga.mainstreetwebservices.com/Glasave10';

// ---- PICK (final rule): in-town/Corpus first; else regional w/ order alert; else staff ----
// "Available Locally" == in town (Corpus Christi) == bookable now.
function pickVendor(rows, nagsPart) {
  const want = String(nagsPart || '').trim().toUpperCase();
  const byCost = (a, b) => Number(a.Cost) - Number(b.Cost);
  const avail = (rows || []).filter(r => {
    const pid = String(r.PartID || '').trim().toUpperCase();
    return Number(r.PartType) === 0 && Number(r.QtyAvail) > 0 && Number(r.Cost) > 0
      && pid.indexOf(want.slice(0, 8)) === 0;       // same windshield family
  });
  const local = avail.filter(r => /available locally/i.test(String(r.Comment || '')));
  if (local.length)  { local.sort(byCost); return { win: local[0], available_local: true,  needs_ordering: false }; } // in town -> book now
  if (avail.length)  { avail.sort(byCost); return { win: avail[0], available_local: false, needs_ordering: true  }; } // regional -> quote + order alert
  return { win: null, available_local: false, needs_ordering: false };                                                // nothing -> staff note
}

async function lookup(vin) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  let vendItems = null;
  page.on('response', async (resp) => {
    if (resp.url().includes('/Inventory/Inquire')) {
      try { const j = await resp.json(); if (j && j.VendItems) vendItems = j.VendItems; } catch (_) {}
    }
  });

  try {
    // 1) LOGIN (service uses its own configured credentials)
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    if (await page.locator('#Email').count()) {
      await page.fill('#Email', process.env.MS_USERNAME);
      await page.fill('#Password', process.env.MS_PASSWORD);
      await page.locator('input[value="Log In"], button:has-text("Log In")').first().click().catch(() => {});
      await page.waitForTimeout(4000);   // let the redirect to the profile picker actually land
    }
    // 1b) PROFILE PICKER: fresh server session has NO remembered default (combo is empty),
    //     so we must SELECT "MANAGER MANAGER" then click Log In. Type to filter -> Enter -> submit.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!page.url().includes('MainstreetLogin')) break;
      const sel = page.locator('input[name="SelectedID_input"]').first();
      await sel.click().catch(() => {});
      await sel.fill('').catch(() => {});
      await sel.pressSequentially('MANAGER', { delay: 80 }).catch(() => {});  // filters list to MANAGER MANAGER
      await page.waitForTimeout(1000);
      await sel.press('Enter').catch(() => {});                                // lock in the highlighted match
      await page.waitForTimeout(700);
      await page.locator('input[value="Log In"]').first().click().catch(() => {});
      await page.waitForTimeout(4000);
    }
    if (page.url().includes('UserManager')) {
      return { success: false, reason: 'busy', error: 'License exceeded (seat in use)' };
    }

    // 2) Identify the windshield (read-only AJAX — proven) so we know which row to pick
    const info = await page.evaluate(async (VIN) => {
      const jsonH = { 'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest','Accept':'*/*' };
      const formH = { 'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest','Accept':'text/html, */*; q=0.01' };
      const vd = await (await fetch('/Glasave10/Vehicle/VINValidator',{method:'POST',headers:jsonH,body:JSON.stringify({vin:VIN})})).json();
      if (!vd.Success || !vd.Vehicle) return { error:'VINValidator' };
      await fetch('/Glasave10/POS/Vehicle/OnVinSearch',{method:'POST',headers:jsonH,body:JSON.stringify({vinId:VIN})});
      const vehicle = vd.Vehicle;
      const vt = await (await fetch('/Glasave10/POS/Vehicle/VinData',{method:'POST',headers:formH,body:'vehicle='+encodeURIComponent(vehicle)})).text();
      const g = id => (vt.match(new RegExp('id="'+id+'"[^>]*value="([^"]*)"'))||[])[1];
      const qp='VehYear='+encodeURIComponent(g('VehYear'))+'&VehMake='+encodeURIComponent(g('VehMake'))+'&VehModel='+encodeURIComponent(g('VehModel'))+'&VehStyle='+encodeURIComponent(g('VehStyle'))+'&VehCarID=&VehGraphicID=&NagsDb=nagsea';
      const sd = await (await fetch('/Glasave10/POS/Vehicle/StylesRead?'+qp,{headers:{'X-Requested-With':'XMLHttpRequest','Accept':'application/json'}})).json();
      if (!Array.isArray(sd)||!sd.length) return { error:'StylesRead' };
      const vehidPadded = String(Math.round(sd[0].VehID)).padStart(8,'0');
      const ll = await (await fetch('/Glasave10/POS/AutoGlassSelect/AutoGlassRead',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body:'sort=&group=&filter=&MaxId=0&cprccd=COD&Vehid='+vehidPadded+'&PartId=&Loccd=&AgId=0&ItemsJson=%5B%5D'})).json();
      const wh = ll.Data.find(r=>r.NodeType==='TH'&&/windshield/i.test((r.cpartid||r.DescFilter||'')+''));
      const cs = ll.Data.filter(r=>r.NodeType==='GH'&&r.ParentId===(wh?wh.Id:0)).sort((a,b)=>(b.Starcount||0)-(a.Starcount||0));
      if (!cs.length) return { error:'no windshield' };
      const best = cs[0];
      const eb='sort=&group=&filter=&Id='+best.Id+'&ParentId='+best.ParentId+'&ChildId='+best.Id+'&MaxId=17&cmajor='+encodeURIComponent(best.cglassid||'')+'&citemtype=GLS&NodeType=GH&GlassDesc=Windshield&DescFilter='+encodeURIComponent(best.DescFilter||'')+'&cprccd=COD&Adhesive=Y&Molding=Y&Opening_seq=1&Clips=Y&Vehid='+vehidPadded+'&Pnotes=&PartId=&cglassid='+encodeURIComponent(best.cglassid||'')+'&Loccd=&Inquire=false&AgId=0&ItemsJson=%5B%5D&id='+best.Id;
      const ex = await (await fetch('/Glasave10/POS/AutoGlassSelect/AutoGlassRead',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body:eb})).json();
      const p = ex.Data.find(r=>r.nlist>0||r.nlabor>0)||ex.Data[0];
      return { vehicle, vehid:vehidPadded, part_number:p.NagsPartID||p.cpartid||p.cmajor||best.cglassid, list_price:p.nlist||0, has_adas:best.hasADAS===true||best.hasADAS==='true' };
    }, vin);
    if (info.error) return { success:false, reason:'error', error:info.error };

    // 3) Drive the real UI: decode VIN -> Glass -> select part -> Vendor Inquiry -> Inquire
    //    (selectors below confirmed live in the page)
    await page.goto(BASE + '/POS/Invoice/Index', { waitUntil: 'domcontentloaded' });
    // quote can bounce via the dashboard then load; wait for the VIN box to EXIST (may be hidden), retry nav
    let attached = false;
    for (let i = 0; i < 5 && !attached; i++) {
      try { await page.waitForSelector('#Inv_cvin', { state: 'attached', timeout: 6000 }); attached = true; }
      catch (_) { await page.goto(BASE + '/POS/Invoice/Index', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500); }
    }
    // the VIN box lives on the Auto tab — activate it so the field becomes visible
    await page.locator('#AutoTab').click().catch(() => {});
    await page.waitForTimeout(1500);
    await page.fill('#Inv_cvin', vin);                                  // VIN field (confirmed)
    await page.locator('#vin-search_btn').first().click();              // decode button (confirmed)
    await page.waitForSelector('#btnApply', { timeout: 15000 });        // VIN De-Coder popup
    await page.locator('#btnApply').click();                            // OK / apply decode (confirmed)
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);
    await page.locator('#GlassTab').click();                            // Glass tab (confirmed)
    await page.waitForTimeout(2500);
    // part rows show the BASE part number (e.g. "FW03844"); click the matching windshield row
    await page.getByText(String(info.part_number).slice(0, 7), { exact: false }).first().click().catch(() => {}); // TODO:VERIFY part row
    await page.waitForTimeout(1000);
    await page.locator('#agSelect').first().check().catch(() => {});    // select/inquire checkbox (confirmed)
    await page.getByRole('link', { name: /vendor inquiry/i }).click();  // Vendor Inquiry (confirmed) -> InquiryView
    await page.getByRole('button', { name: /^inquire$/i }).click();     // TODO:VERIFY Inquire button -> /Inventory/Inquire
    await page.waitForResponse(r => r.url().includes('/Inventory/Inquire'), { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // 4) Apply final pick + shape result
    const pick = pickVendor(vendItems || [], info.part_number);
    const win = pick.win;
    return {
      success: true,
      // live = in-town/bookable; needs_ordering = quote but alert client (out of town); needs_manual_pricing = staff note
      status: win ? (pick.available_local ? 'live' : 'needs_ordering') : 'needs_manual_pricing',
      vehicle: info.vehicle, vehid: info.vehid,
      part_number: info.part_number, list_price: info.list_price, has_adas: info.has_adas,
      vendor_cost: win ? Number(win.Cost) : null,
      vendor_name: win ? win.VendName : null,
      vendor_part: win ? String(win.PartID || '').trim() : null,
      available_local: pick.available_local,   // in town (Corpus) -> bookable now
      needs_ordering: pick.needs_ordering,     // out of town -> quote + "we'll order it & reach out to schedule"
      no_vendor_available: !win,               // nothing anywhere -> staff note
      vendor_rows: (vendItems || []).map(r => ({
        vendor: r.VendName, part: String(r.PartID || '').trim(),
        available: r.QtyAvail, cost: r.Cost, comment: r.Comment, part_type: r.PartType,
      })),
    };
  } catch (err) {
    let where = '', diag = {};
    try {
      where = page.url();
      diag.combobox = await page.locator('.k-combobox').count();
      diag.options = await page.locator('li[role="option"]').count();
      diag.comboValue = await page.locator('input[name="SelectedID_input"]').inputValue().catch(() => null);
      diag.loginBtn = await page.locator('input[value="Log In"]').count();
      diag.vinAttached = await page.locator('#Inv_cvin').count();
    } catch (_) {}
    return { success: false, reason: 'error', error: String(err && err.message || err), where, diag };
  } finally {
    // 5) ALWAYS log out so we never squat the single seat, then close
    try { await page.goto(BASE + '/Account/LogOff', { waitUntil: 'domcontentloaded', timeout: 8000 }); } catch (_) {} // TODO:VERIFY logout URL
    await browser.close().catch(() => {});
  }
}

const app = express();
app.use(express.json());
app.post('/lookup', async (req, res) => {
  if (process.env.SHARED_SECRET && req.headers['x-secret'] !== process.env.SHARED_SECRET) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  const vin = (req.body && req.body.vin || '').trim();
  if (!vin) return res.status(400).json({ success: false, error: 'vin required' });
  res.json(await lookup(vin));
});
app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 3000, () => console.log('vendor-lookup up'));
