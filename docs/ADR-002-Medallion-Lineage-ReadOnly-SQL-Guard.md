# ADR-002: Medallion Lineage DAG Verification & Dual-Layer Read-Only SQL Guardrail

- **Status:** Accepted (Implemented in v4.0)
- **Author:** Truong Van Tinh (`tvt987`)
- **Date:** 2026-11-28
- **Scope:** `backend/nexus_api/lakehouse.py`, `backend/nexus_api/main.py`, `web/src/engines/lineageGraphEngine.ts`, `web/src/components/SchemaLineageView.tsx`

---

## 1. Context

Upgrading NEXUS LAKE into a full-stack analytical lakehouse monorepo introduces two enterprise-critical requirements:
1. **End-to-End Medallion Governance (`Bronze -> Silver -> Gold`):** Analysts and data engineers need deterministic lineage visibility across raw CDC streams, cleaned conformed facts, and materialized KPI marts—along with provable cycle-freedom (DAG integrity), null-rate quality scoring, partition-pruning cost estimates, and safe topological refresh ordering.
2. **Untrusted Ad-Hoc SQL Execution Security:** Exposing an HTTP SQL execution endpoint (`POST /api/v1/sql/execute`) to BI users, notebooks, or LLM/MCP agents creates severe SQL injection, schema mutation (`DROP`/`ALTER`/`DELETE`), privilege escalation (`PRAGMA`/`ATTACH`/`load_extension`), and resource exhaustion (unbounded full-table `SELECT`) risks.

---

## 2. Decision

### A. Cycle-Free Medallion DAG Topology (Kahn's Topological Sort)
Both the TypeScript frontend (`web/src/engines/lineageGraphEngine.ts`) and Python 3.12 FastAPI backend (`backend/nexus_api/lakehouse.py`) enforce graph integrity with Kahn's in-degree topological sorting algorithm:
- Every `GET /api/v1/catalog/lineage` response dynamically introspects SQLite row counts and column-level null rates, computes `quality_grade` (`A < 1%`, `B < 5%`, `C >= 5%`), and returns `is_acyclic` + `topological_order`.
- Materialized view incremental refreshes strictly follow `topological_order` (Bronze -> Silver -> Gold), guaranteeing downstream KPI cubes never read stale upstream transforms.
- On the client, BFS ancestor/descendant traversal computes highlighted upstream/downstream node and edge sets in $O(|V| + |E|)$ time when clicking any table card in `SchemaLineageView`.

### B. Dual-Layer Defense-in-Depth Read-Only SQL Guardrail
Every call to `POST /api/v1/sql/execute` passes through two independent security barriers before touching data:

1. **Layer 1 — Comment-Stripping Lexical AST Guard (`validate_readonly_sql`):**
   - Strips `--` line comments and `/* ... */` block comments (rejecting unterminated comments).
   - Replaces single-quoted string literals (`'...'` including escaped `''`) with inert placeholders so benign predicates like `WHERE category != 'DROP_TEST'` never trigger false positives.
   - Rejects any stacked multi-statement `;` payloads with HTTP `403`.
   - Enforces leading statement whitelist (`SELECT`, `WITH`) and blocks all DDL/DML/admin tokens (`DROP`, `DELETE`, `UPDATE`, `INSERT`, `REPLACE`, `ALTER`, `CREATE`, `TRUNCATE`, `ATTACH`, `DETACH`, `PRAGMA`, `VACUUM`, `REINDEX`, `LOAD_EXTENSION`, `EXEC`, `GRANT`, `BEGIN`, `COMMIT`, `ROLLBACK`, `COPY`) with HTTP `403`.

2. **Layer 2 — SQLite C-Engine Authorizer Sandbox (`conn.set_authorizer`):**
   - Prior to executing both `EXPLAIN QUERY PLAN` and the query cursor, the engine installs `_sqlite_readonly_authorizer`, which permits strictly `SQLITE_SELECT`, `SQLITE_READ`, and safe `SQLITE_FUNCTION` actions while denying `load_extension`, writes, pragmas, schema DDL, and database attachment inside SQLite's C VM.
   - Restores `set_authorizer(None)` inside a `finally` block under an `RLock` so catalog maintenance (`POST /api/v1/catalog/refresh`) remains cleanly isolated.

3. **Bounded Row Cap & Real Query Plan Telemetry:**
   - Every query is bounded via `cursor.fetchmany(min(max_rows, 1000) + 1)` with an explicit `truncated` boolean, eliminating OOM payloads.
   - Executes real `EXPLAIN QUERY PLAN` to report scan/index usage alongside estimated scan rows, partition pruning ratio, and memory footprint MB.

---

## 3. Consequences

### Positive
- **Zero-Native-Build Portability:** Uses Python 3.12 built-in `sqlite3` + FastAPI + Pydantic v2, compiling and passing 25 `pytest` integration tests in `< 2s` on Windows, Linux, and slim Docker containers without requiring heavy C++ database drivers during local evaluation.
- **Defense-in-Depth Resistance:** Even if a novel SQL syntax bypassed regex/token inspection, SQLite's C-level authorizer unconditionally denies write/attach/pragma opcodes.
- **Deterministic Data Quality Profiling:** `POST /api/v1/ingest/profile-csv` catches `HIGH_NULL_RATE`, `CONSTANT_COLUMN`, `NUMERIC_OUTLIERS`, `MIXED_TYPE_VALUES`, and `DUPLICATE_ROWS` before raw CSVs enter Silver tables.

### Trade-Offs
- In single-container evaluation mode, SQLite serves concurrent reads via an `RLock` + `:memory:` or local file path. For horizontally scaled multi-replica deployments, `docker-compose.yml` provisions `postgres:16-alpine` (metadata catalog) and `minio` (Parquet object storage) as drop-in persistence tiers behind the same FastAPI repository interface.
