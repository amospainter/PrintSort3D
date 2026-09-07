# Backlog — deferred work

Items intentionally scoped out, with enough context to pick them up later. Not a
prioritized roadmap; move an entry into a PR when it's actually being done and delete it
from here.

---

## Paint colors on the raw full-res model

**Status:** deferred (2026-09-06). LOE ~1.5–2 days done properly, ~1 day quick-and-dirty.

### Background

The Detail viewer has two geometry sources for a catalogued file:

- **Server-baked mesh** (`server/src/meshBake.ts` → `mesh.bin.gz`): full geometry (no
  decimation), build-graph transforms folded in, **per-triangle filament slots included**
  (`mesh.userData.paint`). `client/src/loadModel.ts` `applyPaintColors` reads those slots.
- **Raw source file** parsed in-browser by three's `STLLoader` / `OBJLoader` /
  `ThreeMFLoader`. The viewer auto-prefers this for source files `< FULL_MODEL_AUTO_BYTES`
  (5 MB) — see `Detail.tsx`. **No paint data** — three's `ThreeMFLoader` doesn't expose the
  `paint_color` attribute.

Current behavior (`Detail.tsx`): ticking "Show painted colors" sets
`preferRaw={loadFull && !painted}`, i.e. **turning paint on forces the viewer back to the
baked mesh**. So the painted view is always the baker's output, never the raw-loader model.

### Why it's deferred

The baked mesh *is* the full-fidelity model now that the sci-notation vertex bug
(`meshBake.ts` / `geometryParse.ts`, fixed 2026-09-06, `CURRENT_SCANNER_VERSION` 9) is
resolved — no decimation, transforms applied, paint included. Building a second paint
pipeline for the raw path is real work for a mostly-cosmetic "which parser produced this"
distinction.

### The work, if we do it

Port the bake to the browser so the raw 3MF path can carry paint:

| Piece | Effort |
|---|---|
| Browser unzip dep (`fflate` — `adm-zip` is Node-only) + wiring | 0.5–1h |
| `server/src/paintColor.ts` → client (pure, zero deps — copy or share) | ~0.5h |
| `server/src/meshBake.ts` 3MF path → client: regex XML parse, `<build>`→`<object>`→`<component p:path>` graph, affine transform compose; swap `Buffer`→`TextDecoder`. STL/OBJ need nothing (no paint). | 3–5h |
| `loadModel.ts`: new `loadRawThreeMfWithPaint()` returning a `THREE.Group` shaped like `loadBakedMesh` (one mesh per build item, `userData.paint` set) so `applyPaintColors` works unchanged | 1–2h |
| Tests — port `meshBake.test.ts` cases to the client, or factor a shared module + one integration test | 2–3h |
| `Detail.tsx`: drop the `!painted` forcing; keep the size guard (a big 3MF parsed on the main thread is exactly what the bake exists to avoid) | ~0.5h |

**Proper version** (~2 days): move `meshBake` + `paintColor` + `geometryParse` core into a
shared dir both packages import (with an injected unzip + text-decode shim), so the client
runs the *exact same* baking code and output can't drift. Costs monorepo plumbing (two
tsconfigs, build wiring). **Quick version** (~1 day): client-side copy-paste port, accept
the duplication risk.

### Cheaper alternatives considered

- **~30 min:** for painted multi-filament 3MFs only, always use the baked mesh regardless
  of size (skip the raw path for those files). Paint works, geometry is complete.
- **~0:** treat "Load full model" as the debug escape hatch it basically is, and accept
  that paint implies the baked mesh.
