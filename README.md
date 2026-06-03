# Mainstreet Vendor-Cost Lookup Service

Deterministic Playwright service that logs into Mainstreet Glas-Avenue, runs a
Vendor Inquiry for a VIN's windshield, and returns the cheapest **locally
available** distributor cost. Called from n8n over HTTP.

## Repo layout
```
mainstreet-vendor-lookup/
├── mainstreet-vendor-lookup.js   # the service
├── package.json
├── Dockerfile
└── README.md
```

## Deploy to Railway (copy-paste)

1. **Make the repo.** Put all four files in one folder, then:
   ```
   git init && git add . && git commit -m "vendor lookup service"
   git branch -M main
   git remote add origin https://github.com/<you>/mainstreet-vendor-lookup.git
   git push -u origin main
   ```

2. **Railway → New Project → Deploy from GitHub repo →** pick the repo.
   Railway sees the `Dockerfile` and builds it automatically (uses the
   Playwright image, so Chromium is already inside — no extra setup).

3. **Variables tab → add:**
   ```
   MS_USERNAME    = mendiola5745@gmail.com
   MS_PASSWORD    = <the Mainstreet password>
   SHARED_SECRET  = <any long random string>
   ```
   (Don't set PORT — Railway injects it; the app reads process.env.PORT.)

4. **Settings → Networking → Generate Domain.** You'll get a public URL like
   `https://mainstreet-vendor-lookup-production.up.railway.app`.

5. **Smoke test:**
   ```
   curl https://<your-domain>/health
   # -> {"ok":true}

   curl -X POST https://<your-domain>/lookup \
     -H "Content-Type: application/json" \
     -H "x-secret: <SHARED_SECRET>" \
     -d '{"vin":"KNDJP3A57E7010311"}'
   # -> { success, vehicle, part_number, vendor_cost, vendor_name,
   #      no_vendor_available, vendor_rows[...] }
   ```
   First run may need the 4 `// TODO:VERIFY` selectors tuned (logs show where).

## Wire into n8n (replaces WF2's Browserbase node)
- **HTTP Request** node:
  - Method: `POST`
  - URL: `https://<your-domain>/lookup`
  - Header: `x-secret` = your SHARED_SECRET
  - Body (JSON): `{ "vin": "{{ $json.vin }}" }`
  - Timeout: 120000 (the inquiry takes ~30-90s)
- Then map `vendor_cost`, `vendor_name`, `no_vendor_available` into the
  "Compute Customer Price" (WF6) node exactly as before.

## Notes
- Single POS seat: the service logs out at the end of every run. Don't run it
  while logged into Mainstreet elsewhere, or it'll return `reason: "busy"`.
- Local Chromium is used (no Browserless needed for this authenticated POS).
