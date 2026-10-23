# move.rog42.net

Box labels, QR scanning and the move checklists for 133 Oratava Ave → 12 Savoy Court (Sat 7 Nov 2026).
It runs as a single Cloudflare Worker: static files from `public/`, the API in `src/`, and a D1 database.

| Path | What it is | Who can use it |
| --- | --- | --- |
| `/` | Box scanning, new labels, every box grouped by Savoy room | Anyone with the link |
| `/b/014` | Where each label's QR code points. Opening it moves box 014 one step | Anyone with the link |
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
| POST | `/api/scan/:id` | Moves the box one step. Returns `moved`, `recent` (within 15 s) or `done` |
| GET | `/api/lists/state` | Checklist items and settings (Access only) |
| POST, PUT, PATCH, DELETE | `/api/lists/doc/:col[/:id]` | `col` is `items` or `meta`. PATCH deep-merges (Access only) |

## Licences

`public/vendor/qrcode-generator-1.4.4.js` is MIT, © Kazuhiko Arase. `public/vendor/jsQR-1.4.0.js` is Apache-2.0, © Cosmo Wolfe.
