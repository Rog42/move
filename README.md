# move.rog42.net

Box labels, QR scanning and the move checklists for 133 Oratava Ave → 12 Savoy Court (Sat 7 Nov 2026).
It runs as a single Cloudflare Worker: static files from `public/`, the API in `src/`, and a D1 database.

| Path | What it is | Who can use it |
| --- | --- | --- |
| `/` | Box scanning, new labels, every box grouped by Savoy room | Anyone with the link |
| `/b/014` | Where each label's QR code points. Opening it moves box 014 one step | Anyone with the link |
| `/board` | Kanban of Packed, Loaded and In room for a tablet or laptop at each house. Refreshes every 3 seconds, keeps the screen awake, and has a QR code so helpers can open the scanner | Anyone with the link |
| `/lists` | Utilities and address-change checklists | Locked until Cloudflare Access is set up (see below) |

Each scan moves a box one step: **labelled → packed → loaded → in room**. A second scan of the same box within 15 seconds is ignored. That means a box with labels on several sides can be turned over and scanned again without skipping a step.

## Deploy (one-off)

The D1 database `move` already exists in the Cloudflare account and is loaded with the checklists, the rooms and box 001. Its id is in `wrangler.toml`.

1. **The Worker.** It's called `move`, is connected to `Rog42/move`, and deploys on every push to `main` with `npx wrangler deploy`. Everything it needs is in `wrangler.toml`: the D1 binding (`DB` → `move`), the static files and the variables. There's nothing to set in the dashboard.
2. **Add the domain.** In the Worker, go to Settings → Domains & Routes → Add → Custom domain and enter `move.rog42.net`. Cloudflare creates the DNS record and certificate. For this to work, rog42.net's DNS has to be on the same Cloudflare account.
3. **Lock the checklists** with Cloudflare Access (Zero Trust → Access → Applications → Add → Self-hosted):
   - Application domains: `move.rog42.net/lists` and `move.rog42.net/api/lists`. Access paths cover everything under them.
   - Policy: Allow, with your and Lu's email addresses.
   - Then tell the app your team name: uncomment `ACCESS_TEAM_DOMAIN` in `wrangler.toml`, set it to the part before `.cloudflareaccess.com` (for example `rog42`), and push. The Worker redeploys on its own.
   - Optional: also set `ACCESS_AUD` to the application's Audience (AUD) tag, which pins tokens to this one app.

Until step 3 is done, `/api/lists/*` returns 403. The account and policy numbers can't be read publicly even for a moment. To deliberately make the checklists public instead, set `LISTS_OPEN = "1"`.

## Printing labels

**Making labels in bulk:** under Make several labels, add rows of room, what (optional) and how many, for example Kitchen × 4 or Desk → Studio × 1, then create them all at once with consecutive numbers. If you leave What blank, the label gets a line to write the contents on.

**To print:** every new label waits there until it's printed. The list is shared, so labels made on a phone can be printed from the Mac. Print all uses the size and sides chosen in New box label. Once you confirm the labels printed OK, they come off the list. Printing a single box with its own Print button takes it off the list straight away.

To try a printer or the scanning without using up box numbers, tick **Test label** before creating. Test labels are numbered T001, T002… and print and scan like real ones. **Delete all**, next to Test labels at the bottom of the box list, clears them and starts test numbering again at T001.

- **Any home printer, from a phone or computer:** choose A4 sheet, 4 labels. Each box goes onto the sheet with Add to sheet, and Print sheet prints once there are enough to fill it, onto Avery L7169 (99.1 × 139 mm, 4 per A4) or plain paper. Print it at 100% / Actual size, never Fit to page. A USB printer on a Mac can be shared to iPhones with Printer Sharing (System Settings → General → Sharing), after which it shows up under AirPrint.
- **HotLabel M6 (USB):** open move.rog42.net on the computer the M6 is plugged into. Choose 4 × 6 in, set how many sides, then tap Print. Each copy prints as its own 4×6 page. In the print dialog, pick the M6, set the paper to 4×6 / 100×150 mm, and set margins to None at 100% scale.
- **MUNBYN 130B or another Bluetooth 4×6 printer, from a phone:** choose 4 × 6 in, set the sides, then tap Share and pick the printer's app (MUNBYN Print). You get a PDF with one exact 4×6 page per copy. The phone's Print button can't see Bluetooth label printers.
- **Mini Bluetooth printer:** choose the 48 mm roll, then Share or Save. With more than one side, the image is a single strip of copies with dashed cut lines. Print it from the printer's app.
- The small die-cut sizes also share as a PDF, one page per copy.
- Every copy of a label carries the same QR code.

## Local development

```sh
npm install
npx wrangler d1 execute move --local --file=schema.sql
npx wrangler dev --port 8788         # http://localhost:8788
```

On localhost, `/lists` is always open, and QR codes point at `http://localhost:8788/b/NNN` instead of move.rog42.net.

To load a fresh copy of the old claude.ai page's data, export each collection to `export/<collection>/<id>.json`, then run:

```sh
python3 tools/make_seed.py export > seed.sql
npx wrangler d1 execute move --local --file=seed.sql
```

`seed.sql` is git-ignored because it holds account numbers.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/state` | Rooms and boxes |
| POST | `/api/boxes` | `{cat, dest}`. The number comes from an atomic counter in D1, so two phones never get the same one |
| PATCH | `/api/boxes/:id` | `{cat?, dest?, status?, resetScan?}` |
| DELETE | `/api/boxes/:id` | The number is never reused |
| POST | `/api/boxes/batch` | `{items: [{cat, dest}], test?}`. Up to 100 labels, consecutive numbers |
| POST | `/api/boxes/printed` | `{ids, printed?}`. Marks labels printed; unprinted ones make up the To print list |
| DELETE | `/api/boxes?test=1` | Deletes every test label (T001…) and restarts test numbering |
| POST | `/api/scan/:id` | Moves the box one step. Returns `moved`, `recent` (within 15 s) or `done` |
| GET | `/api/lists/state` | Checklist items and settings (Access only) |
| POST, PUT, PATCH, DELETE | `/api/lists/doc/:col[/:id]` | `col` is `items` or `meta`. PATCH deep-merges (Access only) |

## Licences

`public/vendor/qrcode-generator-1.4.4.js` is MIT, © Kazuhiko Arase. `public/vendor/jsQR-1.4.0.js` is Apache-2.0, © Cosmo Wolfe.
