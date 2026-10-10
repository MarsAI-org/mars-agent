# Asset / artwork TODO (rebrand)

Brand artwork deliverable: **`Mars`** (CLI `mars`, npm `@marsai-org`,
GitHub `MarsAI-org/mars-agent`).

**Nothing in here may be committed to `main` without review.** Two placeholder
files were created so that asset paths resolve and nothing renders as a broken
image. They contain **no artwork** — no logo, no wordmark, no design — and every
one of them must be replaced before release. `HANDOFF.md` (Phase 5) tracks the
same requirement.

---

## 1. Placeholders created by this change

| File | Format | What it actually is | Replace with |
| --- | --- | --- | --- |
| `assets/mars-logo.png` | PNG, 600×200, grayscale, flat fill | A single neutral gray rectangle (every pixel `#f2f2f2`) plus a `tEXt` chunk whose `Description` reads `PLACEHOLDER - NOT FINAL ARTWORK...`. No drawing, no glyphs. | Final Mars README hero / banner art (see §2.1) |
| `assets/mars-logo.svg` | SVG, viewBox `0 0 240 240` | One neutral gray `rect` plus four monospace `PLACEHOLDER`/`MARS LOGO PENDING` text elements, and a leading SVG comment stating it is a placeholder. No logo geometry. | Final Mars brand mark, vector source (see §2.2) |

Why these two extensions and no third:

- **PNG** — `README.md` renders the hero through an `<img>`; a raster is what
  the slot consumes, and GitHub renders it at up to ~860 px wide.
- **SVG** — the general-purpose brand asset (docs, app icons, future favicons)
  should ship a vector source once; the raster set is then exported from it.
- **No `assets/mars-logo.ico`** — nothing in the repository loads an `.ico`
  from `assets/`. The only `.ico` consumers are the collab-web favicons
  (`packages/collab-web/public/favicon.ico`, referenced from
  `packages/collab-web/index.html:19` and
  `packages/collab-web/public/manifest.webmanifest:11`), which live in their
  own `public/` tree. No `.ico` placeholder was created.

---

## 2. What needs final artwork

### 2.1 `README.md:2` — hero banner

- Reference: `README.md:2` →
  `<img src="assets/mars-logo.png" alt="Mars">` (repointed from `assets/hero.png`).
- Consumer: GitHub README renderer.
- Required size: a wide banner. ~1200×300 to ~1600×400 px; GitHub renders it at
  ~860 px wide, so the art must survive downscaling to that width.
- Required format: PNG (keep a WebP/AVIF export optional). Dark background is
  expected — the README page is dark and the existing hero was dark.
- Expectation: the Mars wordmark and/or symbol, centered, as the repo's
  cover image. Gradients/glow must still read at 860 px wide.

### 2.2 `assets/mars-logo.svg` — brand mark (master)

- Reference: currently referenced by nothing in the repository (see §3). It
  exists as the named master asset for the brand mark.
- Consumer: docs, this placeholder slot, and the source for every derived
  raster in §2.3–§2.6 once one designer owns it.
- Required size: 120×120 minimum viewBox, rectangular mark preferred so the
  square favicon set can crop/scale without re-drawing. Vector required.
- Required format: SVG (the current file is a placeholder with a 240×240
  viewBox).
- Expectation: works at 16 px and at 240 px; survives a monochrome one-color
  reproduction (terminal, footer, small favicon) without losing the shape.

### 2.3 `assets/mars-logo.svg` → GitHub social preview

- Reference: **no consumer yet.** GitHub's own repo social card comes from
  Settings → Social preview; there is no file reference anywhere in the repo.
- Required size: **1200×630 px**.
- Required format: PNG (or JPG) under 1 MB, or an SVG where GitHub accepts it.
- Expectation: brand-consistent card with the Mars mark plus a short tagline
  (the README's one-liner is "A coding agent with the IDE wired in."). Keep
  text out of the outer 120 px — link-preview crops differ per platform.
- This is a *separate* deliverable from §2.1 even though both are banners:
  different aspect ratios (1:1 vs 1.91:1). Do not reuse one file for both.

### 2.4 App / favicon set (not yet referenced from `assets/`)

- Consumer to be decided: the collab-web site already ships its own favicon
  ladder in `packages/collab-web/public/` (16×16, 32×32, 256×256, 180×180,
  192×192, 512×512 via `favicon-16x16.png`, `favicon-32x32.png`,
  `favicon.png`, `favicon-180x180.png`, `favicon-192x192.png`,
  `favicon-512x512.png`, plus `favicon.ico`, `favicon.svg` and
  `og-image.png`) — none of those files is in this file
  set and none is renamed here.
- If those are re-derived from the Mars mark, the set the site actually loads
  must be complete: 16×16, 32×32, 512×512 PNG (the site's current ladder), a
  256×256 `favicon.png`, a 192×192 PNG for the manifest, a 180×180 Apple touch
  icon, a `favicon.ico` (multi-resolution: 16/32/48 inside the one file — note
  there is no standalone `favicon-48x48.png` in `public/` today), and the
  `og-image.png` at 1200×630 (see §2.3).
- Expectation: at 16×16 the mark must be a solid silhouette — drop to a single
  color and simplify the shape by hand. Anti-aliased gradients disappear at
  that size.

### 2.5 TUI wordmark / terminal glyph

- Reference: **none anywhere in the repo.** `REBRAND_AUDIT.md` §7 records there
  is no ASCII-art logo banner and the wordmark is only the `APP_NAME` string
  plus the README hero image.
- Consumer: TUI startup banner / `--version` / help header (optional; no code
  currently loads any art).
- Required format: if it is a real asset, a plain-text/ASCII mark in a `.txt`
  file sized for 80 columns, plus an ANSI color variant if the banner renders
  color. If it stays code-only, no asset is needed — that is a product call,
  not an art deliverable.
- Expectation: `Mars` must be legible in a 6×10 terminal font cell and degrade
  without color.

### 2.6 Other consumer-owned art (report only — outside this file set)

These consume brand imagery but live outside `assets/`; the owners need the
final mark, not a placeholder from this change.

| Path / reference | Size / format | Note |
| --- | --- | --- |
| `packages/collab-web/index.html:36-39` → `og:image` `https://my.omp.sh/og-image.png` | 1200×630 PNG | Still points at the **upstream** hosted domain. The image itself needs a Mars version; the URL needs a decided Mars host first (`HANDOFF.md` open TODO #2). |
| `packages/collab-web/public/og-image.png` | 1200×630 PNG | Exists (upstream art). Referenced by the line above once hosted on a Mars domain. |
| `packages/collab-web/index.html:19-25` → `public/favicon.svg` (:19), `public/favicon.ico` (:20), `public/favicon.png` 256×256 (:21), `public/favicon-32x32.png` (:22), `public/favicon-16x16.png` (:23), `public/favicon-180x180.png` (:24) | see §2.4 | Exists (upstream art). Referenced from `index.html`. |
| `packages/collab-web/public/manifest.webmanifest:11-16` → `/favicon.svg`, `/favicon-192x192.png`, `/favicon-512x512.png`, `/favicon-180x180.png` | see §2.4 | Exists (upstream art). `favicon-192x192.png` is referenced **only** by the manifest, not `index.html`. |
| `python/robomp/assets/icon.png`, `icon.jpg` | package icon | Exists (upstream art); no reference found in the repo, consumer is the robomp package/registry metadata. Needs a decision, not an edit. |

---

## 3. Full asset inventory (as found, before this change)

Every raster/vector file under the repo, excluding `node_modules`, `.git`,
`packages/collab-web/dist/` (build output) and `scripts/session-stats/out/`
(generated charts).

### 3.1 `assets/`

| File | Referenced by | Status after this change |
| --- | --- | --- |
| `assets/hero.png` (158 KB) | `README.md:2` (was the only reference) | **Now unreferenced** — README points at `assets/mars-logo.png`. Upstream art, left in place. **Decision: delete or keep.** See §4. |
| `assets/icon.svg` | **was already referenced by nothing** | Unreferenced. Pi-symbol art (`REBRAND_AUDIT.md:99`, `:163`, `:164`). Left in place. **Decision: delete or keep.** See §4. |
| `assets/python.webp` | `README.md:150` | Unchanged. Feature screenshot, not brand art. |
| `assets/lspv.webp` | `README.md:158` | Unchanged. Feature screenshot. |
| `assets/ttsr.webp` | `README.md:176` | Unchanged. Feature screenshot. |
| `assets/task.webp` | `README.md:185` | Unchanged. Feature screenshot. |
| `assets/arxiv.webp` | `README.md:215` | Unchanged. Feature screenshot. |
| `assets/review.webp` | `README.md:234` | Unchanged. Feature screenshot. |
| `assets/ask.webp` | `README.md:604` | Unchanged. Feature screenshot. |
| `assets/models.webp` | **none found** | Orphaned. Decision needed. |
| `assets/discovery.webp` | **none found** | Orphaned. Decision needed. |
| `assets/perplexity.webp` | **none found** | Orphaned. Decision needed. |
| `assets/slash.webp` | **none found** | Orphaned. Decision needed. |
| `assets/mars-logo.png` | `README.md:2` | **Created here** — placeholder. |
| `assets/mars-logo.svg` | (master, see §2.2) | **Created here** — placeholder. |

The seven referenced `.webp` files are UI screenshots; the README alt text
already describes them as Mars screenshots. All are indexed by their existing
paths and are out of scope for brand artwork. Their screenshots may contain
old-brand strings inside the captured terminal frames — **that needs a visual
re-check with final artwork, not a text edit.**

### 3.2 Elsewhere

- `packages/ai/test/data/red-circle.png` — test fixture, not art.
- `packages/collab-web/public/*` — favicon ladder + `og-image.png`, see §2.4.
- `packages/collab-web/dist/*` — build output of the above.
- `python/robomp/assets/icon.png`, `icon.jpg` — see §2.6.
- `scripts/session-stats/out/*.png` — generated charts, not art.
- `crates/vendor/**` READMEs reference remote badges/images (upstream vendored
  content), not repo assets.

---

## 4. Decisions needed (not taken here)

1. **`assets/hero.png` and `assets/icon.svg` are now dead.** Nothing in the
   repo references either. They are upstream brand art (the Pi symbol and its
   hero) and were deliberately **not deleted** by this change. Delete both, or
   keep `hero.png` as a historical reference? If kept, they must stay out of
   any Mars-named path.
2. **Orphaned screenshots** — `assets/models.webp`, `assets/discovery.webp`,
   `assets/perplexity.webp`, `assets/slash.webp` have no referencing file.
   Delete, or re-introduce them in the README?
3. **Brand color palette.** Every placeholder here is neutral gray. The final
   mark needs one primary accent color plus a dark-bg variant, and the WebP
   screenshots should be re-checked against it (a dark README hero with orange
   accents is the existing visual language).
4. **Mars mark shape.** `assets/icon.svg`'s old symbol was the Pi character
   with a plug connector. A Mars mark should be planned as a distinct shape,
   not a recolor.
5. **Social preview host.** Setting the repo social card requires a decided
   Mars domain for `og:image` resolution (see `HANDOFF.md` open TODO #2).
