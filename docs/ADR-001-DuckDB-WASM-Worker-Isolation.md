# ADR-001: DuckDB-WASM Web Worker Isolation, Strict CSP Arrow IPC & Route-Level Bundle Splitting

- **Status:** Accepted (Implemented in v4.0)
- **Author:** Truong Van Tinh (`tvt987`)
- **Date:** 2026-11-28
- **Scope:** `web/src/engine/duckdbEngine.ts`, `web/vite.config.ts`, `web/index.html`, `web/src/App.tsx`, `web/src/components/SqlNotebookPanel.tsx`

---

## 1. Context

NEXUS LAKE executes vectorized SQL OLAP queries (`GROUP BY`, `QUANTILE_CONT`, window functions, cross-tabs) over 100,000–500,000 retail & SaaS rows directly inside the browser alongside a 60 FPS WebGPU scatter-plot canvas and interactive SVG Medallion Lineage ERD graph.

Running an analytical SQL engine in browser environments introduces four critical production failure modes:
1. **Main-Thread UI Freezes:** Synchronous query evaluation or CSV parsing stalls pointer/scroll input and breaks 60 FPS GPU rendering.
2. **External CDN Outages & CORS Failures:** Default `@duckdb/duckdb-wasm` bundle loaders fetch `.wasm` and `.worker.js` files from `cdn.jsdelivr.net`, which violates enterprise strict CSP policies and fails in air-gapped VPC deployments.
3. **Strict Content-Security-Policy (`'unsafe-eval'` ban):** Upstream `apache-arrow` (`builder/valid.mjs`) dynamically constructs `new Function(...)` switch statements to check null sentinels, triggering immediate CSP violation exceptions when `script-src` omits `'unsafe-eval'`.
4. **Monolithic Entry Bundle Bloat:** Bundling heavy interactive views (`SchemaLineageView`, `CohortHeatmapPanel`, `PivotMatrixPanel`, `DataIngestStudio`, `CrdtMultiplayerLab`, `EnterpriseLicenseModal`) into the main entry chunk slows First Contentful Paint (FCP) on cold loads.

---

## 2. Decision

We adopt a four-part isolation and delivery architecture:

1. **Self-Hosted Worker-Isolated DuckDB-WASM (`?url` static imports):**
   - Import `duckdb-mvp.wasm`, `duckdb-eh.wasm`, `duckdb-browser-mvp.worker.js`, and `duckdb-browser-eh.worker.js` directly through Vite `?url` asset imports so all execution artifacts are served same-origin under `worker-src 'self' blob:` and `script-src 'self' 'wasm-unsafe-eval' blob:`.
   - Ingest columnar `TypedArray` batches over binary Apache Arrow IPC streams (`tableToIPC` -> `conn.insertArrowFromIPCStream`) to bypass CSV stringification overhead (>6x faster ingestion).
   - Maintain a deterministic pure-TypeScript columnar fallback (`FALLBACK-OLAP`) so unit tests (`jsdom`) and worker-restricted enterprise environments remain 100% functional without runtime crashes.

2. **Compile-Time CSP-Safe Apache Arrow Transform (`cspSafeApacheArrowPlugin`):**
   - Replace `apache-arrow/builder/valid.mjs`'s `createIsValidFunction` at Vite transform time with a pure-JS `Set` + `NaN` closure, preserving identical null-validation semantics while eliminating every `new Function()` call across the entire bundle.

3. **Explicit Route/Panel Code Splitting (`React.lazy` + `Suspense`) & Rollup `manualChunks`:**
   - Lazy-load secondary workspace views and cell renderers (`SchemaLineageView`, `CohortHeatmapPanel`, `PivotMatrixPanel`, `QueryPlanPanel`, `DataIngestStudio`, `CrdtMultiplayerLab`, `ArchitectureInspector`, `EnterpriseLicenseModal`).
   - Partition long-lived vendor & domain layers via Rollup `manualChunks` (`react`, `duckdb`, `arrow`, `table`, `crdt`, `icons`, `engines`), keeping the main entry chunk lean (`~121 kB` raw / `~32.8 kB` gzip) and maximizing CDN/browser cache hit rates across releases.

---

## 3. Consequences

### Positive
- **Zero CSP Violations:** Runs cleanly under strict `Content-Security-Policy` (no `'unsafe-eval'`, `object-src 'none'`, `Referrer-Policy: strict-origin-when-cross-origin`).
- **60 FPS Responsiveness:** Heavy OLAP scans execute off the main thread in dedicated Web Workers while WebGPU/SVG interactions stay smooth.
- **Fast Initial Load & Modular Caching:** Core entry JS shrinks dramatically while `react`, `duckdb`, `arrow`, and `engines` cache independently across deployments.
- **Air-Gapped & Offline Ready:** Zero dependency on external JS/WASM CDNs.

### Trade-Offs
- Self-hosted DuckDB `.wasm` assets add ~73 MB uncompressed (~16.5 MB gzipped, lazily loaded only by the Worker) to static hosting storage.
- Requires keeping `cspSafeApacheArrowPlugin` synchronized if `apache-arrow` changes internal file paths on major upgrades (mitigated by Playwright zero-CSP-error E2E gate).
