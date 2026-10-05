# Workout Logger

An offline-first workout logger for iPhone. It's a Progressive Web App (PWA) that you add to the home screen, and it syncs to a Google Sheet named **Joseph Workout Log**. An AI coach (Claude) reads that sheet through the Google Drive connector.

- **Frontend:** `/app`, a static PWA in vanilla HTML/CSS/JS with no framework and no build step. It's hosted on a Cloudflare Worker, which also sends rest-timer alerts.
- **Backend:** `/apps-script`, a Google Apps Script web app bound to the sheet.
- **Worker:** `/worker`, which serves `app/` and pushes a notification when a rest ends.
- **Tests:** `/tests`, an end-to-end offline test in Playwright. It runs the real `Code.gs` against an in-memory fake of Google Sheets.

```
app/            index.html, app.js, styles.css, sw.js, manifest.json, icons/
apps-script/    Code.gs, appsscript.json
worker/         index.js (router + RestTimer Durable Object), webpush.js (VAPID)
wrangler.jsonc  Worker config
tests/          offline.test.mjs (Playwright), fake-gas.mjs (Apps Script fakes)
tools/          make-icons.mjs (renders the barbell icon PNGs), make-vapid.mjs
.github/workflows/deploy.yml  (test, then wrangler deploy)
```

---

## 1. Set up the Google Sheet and backend

There's no `clasp` in this setup, so you do these steps by hand once. They take about 5 minutes.

1. Go to **https://sheets.new**. Click the title "Untitled spreadsheet" and rename it **`Joseph Workout Log`**.
2. In the menu, click **Extensions → Apps Script**. A script editor opens, bound to the sheet.
3. In the editor, click `Code.gs` on the left, select all and delete it, then paste in the whole of [`apps-script/Code.gs`](apps-script/Code.gs). Press **⌘S** to save.
4. *(Recommended)* Click the **⚙️ Project Settings** gear on the left:
   - Tick **"Show 'appsscript.json' manifest file in editor"**.
   - Set **Time zone** to your own time zone.
   - Go back to **Editor ⟨⟩**, open `appsscript.json` and replace its contents with [`apps-script/appsscript.json`](apps-script/appsscript.json). Keep the time zone you picked. Save.
5. In the toolbar's function dropdown (next to **▷ Run** / **Debug**), choose **`setup`** and click **▷ Run**.
   - Click **Review permissions** and pick your Google account.
   - You'll see "Google hasn't verified this app". That's expected, because it's your own script. Click **Advanced → Go to … (unsafe) → Allow**.
   - The script only asks for access to *this one spreadsheet* (`@OnlyCurrentDoc`).
6. The **Execution log** at the bottom prints `Your app token is: …` followed by a 64-character token. **Copy it.**
   - It's stored under **⚙️ Project Settings → Script Properties → `TOKEN`**. You can view or replace it there.
   - You can run `rotateToken()` later to issue a new one. You'll then need to update the phone in Settings.
7. Check the sheet. It now has three tabs: **Plan** (seeded with Days A/B/C), **Log** and **Sessions**.
8. Back in the script editor, click **Deploy → New deployment**.
   - Click the ⚙️ next to "Select type" and choose **Web app**.
   - Description: `v1`.
   - **Execute as: Me**.
   - **Who has access: Anyone**.
   - Click **Deploy**. Authorize again if it asks.
   - **Copy the Web app URL**. It looks like `https://script.google.com/macros/s/AKfy…/exec`.
9. To check that it works, open this in a browser: `<that URL>?action=ping&token=<your token>`. You should see `{"ok":true,…}`. With a wrong token you'll get `{"ok":false,"error":"unauthorized"}`.

"Anyone" access is required so the phone can reach the URL without a Google login. The token is what keeps other people out: every request without the right token is rejected.

**Changing `Code.gs` later:** go to **Deploy → Manage deployments**, click ✏️ on the existing deployment, set **Version: New version**, then **Deploy**. The URL stays the same. Don't use "New deployment", because that creates a new URL.

<details><summary>Using clasp instead</summary>

```bash
npm i -g @google/clasp && clasp login
# Create the sheet and bound script first (steps 1–2 above), then copy the Script ID from Project Settings:
cd apps-script && clasp clone <SCRIPT_ID> --rootDir . && git checkout Code.gs appsscript.json
clasp push            # upload Code.gs + manifest
clasp run setup       # or run it from the editor (first run needs the browser to authorize)
clasp deploy -d v1    # then use the /exec URL from `clasp deployments`
```
</details>

## 2. Deploy the app (Cloudflare Worker)

One Worker serves `app/` and the rest-alert API. It's on the free plan.

**One-time setup**
1. `npx wrangler login`
2. `npx wrangler deploy`. Note the URL it prints (`https://workout-logger.<you>.workers.dev`).
3. `node tools/make-vapid.mjs | npx wrangler secret put VAPID_PRIVATE_KEY` (the key that signs pushes).
4. `npx wrangler secret put APP_TOKEN`, then paste the **same token** as Apps Script.
5. For auto-deploys, create a Cloudflare API token (dashboard → My Profile → API Tokens → template **Edit Cloudflare Workers**), then:
   `gh secret set CLOUDFLARE_API_TOKEN` and `gh secret set CLOUDFLARE_ACCOUNT_ID` (the ID is shown by `npx wrangler whoami`).

After that, every push runs the tests, and pushes to the default branch run `wrangler deploy` (`.github/workflows/deploy.yml`).

Don't regenerate `VAPID_PRIVATE_KEY` casually. If you do, tap **Re-register** on the phone (Settings → Rest alerts).

## 3. Install on the iPhone

1. Open the workers.dev URL in **Safari**. It has to be Safari, because other iOS browsers can't install PWAs.
2. Tap **Share** (□↑), then **Add to Home Screen**, then **Add**.
3. Launch it from the home screen icon. It opens full-screen with no Safari bars.
4. On the setup screen, paste the **Web app URL** and the **token**, then tap **Save & connect**.
   - Tip: AirDrop or Notes them to yourself, then copy and paste.
5. Open the app once while online. That caches the app shell and downloads the Plan. After that it works with no signal at all.
6. **Settings → Rest alerts → Enable rest alerts**, then Allow. Tap **Send a test alert in 5 s** and lock the phone. Your watch should buzz.

> The home-screen app has its own storage, separate from Safari's. Always use the icon, not a Safari tab.

## 4. How updates roll out

- Every deploy stamps `app/sw.js` with the commit SHA (`const BUILD = '…'`). The cache name becomes `wl-shell-<VERSION>-<sha>`, so the browser treats it as a new service worker.
- The phone checks for a new version when the app opens and each time it comes back to the foreground. It downloads the new files in the background and shows **"Update available — tap to reload"**.
- The new version only takes over when you tap that toast, so code never changes in the middle of a set. After the reload, the old cache is deleted.
- Your data is untouched by updates. It lives in IndexedDB, not in the cache.
- You can also check by hand: **Settings → Check for update**.
- Plan changes need no deploy. Edit the **Plan** tab and the app picks it up the next time it opens online. A session that's already in progress keeps the plan it started with.

## 5. How it works offline

| What | Where |
|---|---|
| App shell (HTML/JS/CSS/icons) | Service worker cache, served cache-first |
| Plan + recent history (last 1000 sets) | IndexedDB, refreshed in the background when online |
| Every set you log | IndexedDB `sets` (the source of truth), plus the `outbox` in the same transaction |
| In-progress session (drafts, notes, skips, rest timer) | IndexedDB, so it survives the app being killed |

- **Sync:** the outbox is flushed when the app opens, on the `online` event, when the app comes back to the foreground, after each set, and from **Force sync**. iOS has no Background Sync API.
  - Failures back off exponentially: 2 s, 4 s, 8 s… up to 5 min.
  - An outbox entry is deleted only after the server acknowledges its ID.
- **Exactly once:** each set has a UUID `set_id`. The script skips any `set_id` already in **Log**, so a retry after a lost response never duplicates a row. Sessions rows are upserted by `session_id`.
- **No CORS preflight:** POST bodies are JSON sent as `Content-Type: text/plain`.
- **Header indicator:** shows `✓ synced`, `3 pending`, `offline · 3` or `syncing…`. Tap it to force a sync.
- **Settings → Export all data (JSON):** a full local backup through the iOS share sheet. It includes any unsynced items.
- The app calls `navigator.storage.persist()` to make it less likely that iOS evicts the data.

**Rest timer:** it starts automatically after each ✓. It's based on a stored end time, so it stays correct after the phone is locked or the app is killed. When it ends you get a short beep and a green screen flash. The beep mixes with Music/Audible instead of pausing them, and it's silent when the ring/silent switch is on. With rest alerts on, the Worker also sends a notification at the end of each rest, so a locked phone's watch buzzes. That needs a connection when the rest starts. Offline, you only get the in-app beep and flash.

## 6. Data layout for the coach

Spreadsheet **`Joseph Workout Log`** has three tabs. Row 1 is the header (exact names below), and there's one record per row with no merged cells, blank spacer rows or formulas. Text columns are stored as plain text. Dates are `YYYY-MM-DD`. Timestamps are ISO 8601 with the phone's UTC offset, e.g. `2026-10-04T18:22:05-05:00`.

### `Plan`: the program (edited by hand; the app reads it)

| col | name | type | example / meaning |
|---|---|---|---|
| A | `day` | text | `A`, `B` or `C` |
| B | `order` | number | Position within the day (1 = first) |
| C | `exercise` | text | `Barbell back squat`. Must match `Log.exercise` exactly |
| D | `sets` | number | `3` |
| E | `target_reps` | text | `8`, `10/leg`, `10/side`, `30 sec`, `~40 yd`, `10–12` |
| F | `target_weight` | text | `105 lb`, `95–115 lb`, `20–25 lb DBs` (per dumbbell), `bodyweight`, `TBD` |
| G | `rest_sec` | number | `120` |
| H | `notes` | text | Cues and constraints |

The app reads the **first number** in `target_reps` / `target_weight` as the prefill. For a range, that's the low end. The unit comes from `target_reps`: `sec` and `yd` are recognized, otherwise it's reps.

### `Log`: one row per set performed

| col | name | type | meaning |
|---|---|---|---|
| A | `set_id` | text (UUID) | Unique per set; the idempotency key |
| B | `session_id` | text (UUID) | Joins to `Sessions.session_id` |
| C | `logged_at` | ISO timestamp | When ✓ was tapped |
| D | `date` | `YYYY-MM-DD` | Local date the session started |
| E | `day` | text | `A` / `B` / `C` |
| F | `exercise` | text | Same name as in `Plan` |
| G | `set_number` | number | 1-based within the exercise for that session |
| H | `weight_lb` | number | Pounds. For DB lifts, **per dumbbell**. `0` = bodyweight only |
| I | `reps_or_amount` | number | Reps, seconds or yards (see `unit`) |
| J | `unit` | text | `reps`, `sec` or `yd` |
| K | `rir` | number or blank | Reps in reserve, 0–4; blank = not recorded |
| L | `pain_flag` | text | `none`, `muscle`, `joint` or `sharp`. `sharp` means the app told the lifter to stop that lift for the day |
| M | `set_note` | text | Optional free text |

### `Sessions`: one row per finished session

| col | name | type | meaning |
|---|---|---|---|
| A | `session_id` | text (UUID) | Joins to `Log.session_id` |
| B | `date` | `YYYY-MM-DD` | |
| C | `day` | text | `A` / `B` / `C` |
| D | `start_time` | ISO timestamp | |
| E | `end_time` | ISO timestamp | |
| F | `duration_min` | number | |
| G | `bodyweight_lb` | number or blank | |
| H | `energy` | number | 1 (drained) to 5 (great) |
| I | `session_notes` | text | Free text, then ` \| `-separated extras: `Skipped: <exercise>` and `<exercise>: <note>` |

**Reading tips for the coach:**
- Sets are append-only and ordered by sync time, not workout time. Sort by `logged_at` when order matters.
- The **top set** for a session is the max `weight_lb`, then the max `reps_or_amount`.
- An exercise that's in `Plan` but has no `Log` rows for a session was skipped. Look for a `Skipped:` note in `Sessions.session_notes`.
- A session abandoned without "Finish" has `Log` rows but no `Sessions` row.

## 7. Development & tests

```bash
npm install            # Playwright (uses the preinstalled Chromium if PLAYWRIGHT_BROWSERS_PATH is set)
npm test               # unit tests + end-to-end offline test
PW_CHANNEL=chrome npm test   # use the installed Google Chrome instead of downloading Playwright's Chromium
npm run test:unit    # Worker unit tests (node --test)
npx wrangler dev       # Worker + app locally; needs .dev.vars with APP_TOKEN and VAPID_PRIVATE_KEY
                       # (runs on http://localhost, so real pushes to an iPhone only work from the deployed https Worker)
npm run serve          # http://localhost:8080 (service workers work on localhost)
npm run icons          # regenerate icons from the SVG in tools/make-icons.mjs
```

`npm test` does the following:
1. Serves `app/`, plus a mock `/exec` endpoint that runs the real `Code.gs` (`setup()`, `doGet`, `doPost`) on in-memory fakes.
2. Configures the app online.
3. Goes offline: network emulation is switched off **and** both servers are shut down.
4. Logs a full 18-set Day A session offline. Halfway through it **kills the browser** and reopens it, so the page is served only by the service worker. It finishes the session, then kills and reopens again.
5. Brings the network back. The first POST is committed by the server but answered with a 500 (a "lost response").
6. Asserts the following:
   - After the retry, the Log tab has **exactly 18 rows with 18 unique `set_id`s** that match the device.
   - There's one complete Sessions row.
   - No CORS preflight was sent, and every POST was `text/plain`.
   - Replaying all 18 sets inserts 0.
7. Checks the "last time" prefill, the history chart and the update-available toast flow.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). You may use, change and share this code for personal or other noncommercial purposes. Commercial use needs the author's permission.
