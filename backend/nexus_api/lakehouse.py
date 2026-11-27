"""SQLite-backed Read-Only Analytical Lakehouse Engine, CSV Profiler & Medallion Lineage DAG."""

from __future__ import annotations

import csv
import io
import math
import random
import re
import sqlite3
import statistics
import threading
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any


class SqlGuardViolationError(PermissionError):
    """Raised when a SQL statement violates the read-only analytical guardrail."""


class SqlExecutionError(ValueError):
    """Raised when a read-only SQL query is syntactically or semantically invalid."""


class CsvProfilingError(ValueError):
    """Raised when uploaded CSV content is empty or malformed."""


FORBIDDEN_SQL_KEYWORDS: frozenset[str] = frozenset(
    {
        "DROP",
        "DELETE",
        "UPDATE",
        "INSERT",
        "REPLACE",
        "ALTER",
        "CREATE",
        "TRUNCATE",
        "ATTACH",
        "DETACH",
        "PRAGMA",
        "VACUUM",
        "REINDEX",
        "LOAD_EXTENSION",
        "EXEC",
        "EXECUTE",
        "GRANT",
        "REVOKE",
        "BEGIN",
        "COMMIT",
        "ROLLBACK",
        "SAVEPOINT",
        "RELEASE",
        "COPY",
    }
)

ALLOWED_LEADING_KEYWORDS: frozenset[str] = frozenset({"SELECT", "WITH"})

DISALLOWED_SQLITE_FUNCTIONS: frozenset[str] = frozenset(
    {"load_extension", "sqlite_compileoption_get", "sqlite_compileoption_used"}
)

REGIONS = ("APAC-VN", "APAC-SG", "NA-WEST", "NA-EAST", "EU-CENTRAL")
CATEGORIES = (
    "RETAIL_POS",
    "VOUCHER_REDEEM",
    "FLASH_SALE",
    "SUBSCRIPTION",
    "B2B_SETTLEMENT",
)
VOUCHERS = ("CONCUNG50K", "FLASH99", "VIP_GOLD", "NEWUSER20", None, None, None)
SEGMENTS = ("Enterprise", "Mid-Market", "Growth")
COHORTS = ("2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06")

DATE_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$"
)
INT_PATTERN = re.compile(r"^[+-]?\d+$")
FLOAT_PATTERN = re.compile(r"^[+-]?(?:\d+\.\d*|\.\d+|\d+[eE][+-]?\d+|\d+\.\d+[eE][+-]?\d+)$")


@dataclass(frozen=True)
class LineageEdgeSpec:
    id: str
    source: str
    target: str
    transform: str
    edge_type: str


@dataclass(frozen=True)
class LineageTableSpec:
    id: str
    name: str
    layer: str
    kind: str
    description: str
    partition_key: str
    refresh_sla_sec: int


MEDALLION_TABLES: tuple[LineageTableSpec, ...] = (
    LineageTableSpec(
        id="bronze_pos_events",
        name="bronze_pos_events",
        layer="bronze",
        kind="stream",
        description="Raw Kafka CDC & POS transaction ledger across 5 global retail regions.",
        partition_key="region, tx_date",
        refresh_sla_sec=15,
    ),
    LineageTableSpec(
        id="bronze_saas_subscriptions",
        name="bronze_saas_subscriptions",
        layer="bronze",
        kind="table",
        description="Raw B2B SaaS subscription cohort snapshots with base and expansion MRR.",
        partition_key="signup_cohort, segment",
        refresh_sla_sec=120,
    ),
    LineageTableSpec(
        id="silver_transactions_clean",
        name="silver_transactions_clean",
        layer="silver",
        kind="table",
        description="Deduplicated, schema-validated POS transactions with normalized risk bands.",
        partition_key="region, category",
        refresh_sla_sec=60,
    ),
    LineageTableSpec(
        id="silver_customer_accounts",
        name="silver_customer_accounts",
        layer="silver",
        kind="table",
        description="Conformed SaaS account ledger with net MRR calculation and churn status.",
        partition_key="segment, signup_cohort",
        refresh_sla_sec=120,
    ),
    LineageTableSpec(
        id="gold_regional_revenue_mart",
        name="gold_regional_revenue_mart",
        layer="gold",
        kind="materialized_view",
        description="Materialized KPI cube serving Regional GMV, Anomaly Count & Settlement Latency.",
        partition_key="region",
        refresh_sla_sec=300,
    ),
    LineageTableSpec(
        id="gold_nrr_cohort_mart",
        name="gold_nrr_cohort_mart",
        layer="gold",
        kind="materialized_view",
        description="Materialized Cohort Retention & Net Revenue Retention (NRR %) executive mart.",
        partition_key="signup_cohort",
        refresh_sla_sec=300,
    ),
)

MEDALLION_EDGES: tuple[LineageEdgeSpec, ...] = (
    LineageEdgeSpec(
        id="e-bronze-pos-silver-tx",
        source="bronze_pos_events",
        target="silver_transactions_clean",
        transform="CDC Dedupe + Risk Banding",
        edge_type="cdc",
    ),
    LineageEdgeSpec(
        id="e-bronze-saas-silver-acct",
        source="bronze_saas_subscriptions",
        target="silver_customer_accounts",
        transform="Net MRR Normalization",
        edge_type="transform",
    ),
    LineageEdgeSpec(
        id="e-silver-tx-gold-rev",
        source="silver_transactions_clean",
        target="gold_regional_revenue_mart",
        transform="GROUP BY Region x Category",
        edge_type="materialize",
    ),
    LineageEdgeSpec(
        id="e-silver-acct-gold-nrr",
        source="silver_customer_accounts",
        target="gold_nrr_cohort_mart",
        transform="Cohort NRR Aggregation",
        edge_type="materialize",
    ),
    LineageEdgeSpec(
        id="e-silver-tx-gold-nrr",
        source="silver_transactions_clean",
        target="gold_nrr_cohort_mart",
        transform="Billing Settlement Cross-Check",
        edge_type="transform",
    ),
)


def _strip_comments_and_strings(sql: str) -> str:
    """Removes SQL comments and replaces quoted literals with placeholders for lexical auditing."""
    out: list[str] = []
    i = 0
    n = len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""

        # Single-line -- comment
        if ch == "-" and nxt == "-":
            i += 2
            while i < n and sql[i] != "\n":
                i += 1
            out.append(" ")
            continue

        # Block /* ... */ comment
        if ch == "/" and nxt == "*":
            i += 2
            closed = False
            while i + 1 < n:
                if sql[i] == "*" and sql[i + 1] == "/":
                    i += 2
                    closed = True
                    break
                i += 1
            if not closed:
                raise SqlGuardViolationError("Unterminated SQL block comment detected.")
            out.append(" ")
            continue

        # Single-quoted string literal ('...' with '' escapes)
        if ch == "'":
            i += 1
            closed = False
            while i < n:
                if sql[i] == "'":
                    if i + 1 < n and sql[i + 1] == "'":
                        i += 2
                        continue
                    i += 1
                    closed = True
                    break
                i += 1
            if not closed:
                raise SqlGuardViolationError("Unterminated SQL string literal detected.")
            out.append(" 'LITERAL' ")
            continue

        out.append(ch)
        i += 1
    return "".join(out)


def validate_readonly_sql(raw_sql: str) -> str:
    """Validates that a SQL query is strictly single-statement, read-only SELECT/WITH."""
    if not raw_sql or not raw_sql.strip():
        raise SqlExecutionError("SQL query must not be empty.")

    sanitized = _strip_comments_and_strings(raw_sql).strip()
    if not sanitized:
        raise SqlExecutionError("SQL query contains only whitespace or comments.")

    # Allow at most a single trailing semicolon; reject stacked statements
    body = re.sub(r";\s*$", "", sanitized)
    if ";" in body:
        raise SqlGuardViolationError(
            "Stacked multi-statement SQL execution is blocked by read-only guardrail."
        )

    tokens = [t.upper() for t in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", body)]
    if not tokens:
        raise SqlExecutionError("SQL query contains no executable tokens.")

    lead = tokens[0]
    if lead in FORBIDDEN_SQL_KEYWORDS:
        raise SqlGuardViolationError(
            f"Forbidden write/admin SQL keyword '{lead}' blocked by read-only guardrail."
        )

    if lead not in ALLOWED_LEADING_KEYWORDS:
        raise SqlGuardViolationError(
            f"Leading statement '{lead}' is not permitted. Only SELECT / WITH queries are allowed."
        )

    for tok in tokens:
        if tok in FORBIDDEN_SQL_KEYWORDS:
            raise SqlGuardViolationError(
                f"Forbidden write/admin SQL keyword '{tok}' blocked by read-only guardrail."
            )

    # Return original trimmed SQL without trailing semicolon for safe execution
    return re.sub(r";\s*$", "", raw_sql.strip())


def _sqlite_readonly_authorizer(
    action_code: int,
    arg1: str | None,
    arg2: str | None,
    db_name: str | None,
    trigger_name: str | None,
) -> int:
    """Defense-in-depth SQLite C-engine authorizer allowing strictly SELECT/READ/FUNCTION."""
    _ = (arg2, db_name, trigger_name)
    if action_code in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ):
        return sqlite3.SQLITE_OK
    if action_code == sqlite3.SQLITE_FUNCTION:
        if arg2 and arg2.lower() in DISALLOWED_SQLITE_FUNCTIONS:
            return sqlite3.SQLITE_DENY
        if arg1 and arg1.lower() in DISALLOWED_SQLITE_FUNCTIONS:
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY


def compute_topological_order(
    table_ids: list[str], edges: list[LineageEdgeSpec]
) -> tuple[bool, list[str]]:
    """Verifies DAG acyclicity via Kahn's algorithm and returns topological ordering."""
    in_degree: dict[str, int] = {tid: 0 for tid in table_ids}
    adj: dict[str, list[str]] = {tid: [] for tid in table_ids}

    for edge in edges:
        if edge.source in in_degree and edge.target in in_degree:
            adj[edge.source].append(edge.target)
            in_degree[edge.target] += 1

    queue: deque[str] = deque(tid for tid, deg in in_degree.items() if deg == 0)
    order: list[str] = []

    while queue:
        curr = queue.popleft()
        order.append(curr)
        for nxt in adj[curr]:
            in_degree[nxt] -= 1
            if in_degree[nxt] == 0:
                queue.append(nxt)

    return len(order) == len(table_ids), order


def _grade_null_rate(null_rate_pct: float) -> str:
    if null_rate_pct < 1.0:
        return "A"
    if null_rate_pct < 5.0:
        return "B"
    return "C"


class NexusLakehouseEngine:
    """Thread-safe SQLite Analytical Lakehouse Engine with Medallion Bronze/Silver/Gold tables."""

    def __init__(self, db_path: str = ":memory:") -> None:
        self._lock = threading.RLock()
        self._started_at = time.perf_counter()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._seed_warehouse()

    @property
    def uptime_ms(self) -> float:
        return round((time.perf_counter() - self._started_at) * 1000.0, 2)

    def _seed_warehouse(self) -> None:
        with self._lock:
            self._conn.set_authorizer(None)
            cur = self._conn.cursor()

            cur.executescript(
                """
                DROP TABLE IF EXISTS gold_nrr_cohort_mart;
                DROP TABLE IF EXISTS gold_regional_revenue_mart;
                DROP TABLE IF EXISTS silver_customer_accounts;
                DROP TABLE IF EXISTS silver_transactions_clean;
                DROP TABLE IF EXISTS bronze_saas_subscriptions;
                DROP TABLE IF EXISTS bronze_pos_events;

                CREATE TABLE bronze_pos_events (
                    tx_id TEXT PRIMARY KEY,
                    tx_ts TEXT NOT NULL,
                    tx_date TEXT NOT NULL,
                    store_id TEXT,
                    region TEXT NOT NULL,
                    category TEXT NOT NULL,
                    amount_usd REAL NOT NULL,
                    risk_score REAL NOT NULL,
                    latency_ms INTEGER NOT NULL,
                    voucher_code TEXT,
                    is_anomaly INTEGER NOT NULL
                );

                CREATE INDEX idx_bronze_pos_region ON bronze_pos_events(region);
                CREATE INDEX idx_bronze_pos_category ON bronze_pos_events(category);

                CREATE TABLE bronze_saas_subscriptions (
                    record_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    signup_cohort TEXT NOT NULL,
                    segment TEXT NOT NULL,
                    period_index INTEGER NOT NULL,
                    mrr_vnd REAL NOT NULL,
                    expansion_vnd REAL NOT NULL,
                    is_churned INTEGER NOT NULL
                );

                CREATE INDEX idx_bronze_saas_cohort ON bronze_saas_subscriptions(signup_cohort);

                CREATE TABLE silver_transactions_clean (
                    tx_id TEXT PRIMARY KEY,
                    tx_date TEXT NOT NULL,
                    store_id TEXT NOT NULL,
                    region TEXT NOT NULL,
                    category TEXT NOT NULL,
                    amount_usd REAL NOT NULL,
                    risk_score REAL NOT NULL,
                    risk_band TEXT NOT NULL,
                    latency_ms INTEGER NOT NULL,
                    is_anomaly INTEGER NOT NULL
                );

                CREATE INDEX idx_silver_tx_region ON silver_transactions_clean(region);

                CREATE TABLE silver_customer_accounts (
                    record_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    signup_cohort TEXT NOT NULL,
                    segment TEXT NOT NULL,
                    period_index INTEGER NOT NULL,
                    base_mrr_vnd REAL NOT NULL,
                    expansion_vnd REAL NOT NULL,
                    net_mrr_vnd REAL NOT NULL,
                    is_churned INTEGER NOT NULL
                );

                CREATE INDEX idx_silver_acct_cohort ON silver_customer_accounts(signup_cohort);

                CREATE TABLE gold_regional_revenue_mart (
                    region TEXT NOT NULL,
                    category TEXT NOT NULL,
                    tx_count INTEGER NOT NULL,
                    gross_volume_usd REAL NOT NULL,
                    avg_ticket_usd REAL NOT NULL,
                    anomaly_count INTEGER NOT NULL,
                    avg_latency_ms REAL NOT NULL,
                    PRIMARY KEY (region, category)
                );

                CREATE TABLE gold_nrr_cohort_mart (
                    signup_cohort TEXT NOT NULL,
                    segment TEXT NOT NULL,
                    accounts INTEGER NOT NULL,
                    base_mrr_vnd REAL NOT NULL,
                    expansion_vnd REAL NOT NULL,
                    net_mrr_vnd REAL NOT NULL,
                    nrr_pct REAL NOT NULL,
                    PRIMARY KEY (signup_cohort, segment)
                );
                """
            )

            rng = random.Random(20261128)
            base_dt = datetime(2026, 11, 1, 0, 0, tzinfo=timezone.utc)
            pos_rows: list[tuple[Any, ...]] = []
            for idx in range(1, 601):
                region = REGIONS[idx % len(REGIONS)]
                category = CATEGORIES[(idx * 3 + rng.randint(0, 2)) % len(CATEGORIES)]
                dt = base_dt + timedelta(minutes=idx * 37)
                amount = round(rng.uniform(18.0, 890.0), 2)
                risk = round(rng.uniform(0.05, 0.96), 4)
                is_anom = 1 if risk >= 0.80 else 0
                if is_anom:
                    amount = round(amount * rng.uniform(1.4, 2.3), 2)
                latency = rng.randint(12, 185) + (95 if is_anom else 0)
                voucher = VOUCHERS[idx % len(VOUCHERS)]
                store_id = None if idx % 60 == 0 else f"STR-{(idx % 45) + 101}"
                pos_rows.append(
                    (
                        f"TX-{idx:06d}",
                        dt.isoformat(),
                        dt.strftime("%Y-%m-%d"),
                        store_id,
                        region,
                        category,
                        amount,
                        risk,
                        latency,
                        voucher,
                        is_anom,
                    )
                )

            cur.executemany(
                """
                INSERT INTO bronze_pos_events (
                    tx_id, tx_ts, tx_date, store_id, region, category,
                    amount_usd, risk_score, latency_ms, voucher_code, is_anomaly
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                pos_rows,
            )

            saas_rows: list[tuple[Any, ...]] = []
            rec_idx = 0
            for c_idx, cohort in enumerate(COHORTS):
                for seg in SEGMENTS:
                    base_mrr = (
                        72_000_000.0
                        if seg == "Enterprise"
                        else 26_000_000.0
                        if seg == "Mid-Market"
                        else 9_500_000.0
                    )
                    for acct_num in range(1, 15):
                        rec_idx += 1
                        period = (acct_num + c_idx) % 7
                        churned = 1 if (period >= 3 and rng.random() < 0.14) else 0
                        mrr = round(base_mrr * rng.uniform(0.85, 1.25), 0)
                        expansion = (
                            0.0
                            if churned
                            else round(mrr * rng.uniform(0.04, 0.24), 0)
                        )
                        saas_rows.append(
                            (
                                f"SUB-{rec_idx:05d}",
                                f"ACC-{c_idx + 1}-{seg[:3].upper()}-{acct_num:03d}",
                                cohort,
                                seg,
                                period,
                                mrr,
                                expansion,
                                churned,
                            )
                        )

            cur.executemany(
                """
                INSERT INTO bronze_saas_subscriptions (
                    record_id, account_id, signup_cohort, segment, period_index,
                    mrr_vnd, expansion_vnd, is_churned
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                saas_rows,
            )

            self._rebuild_silver_and_gold(cur)
            self._conn.commit()

    def _rebuild_silver_and_gold(self, cur: sqlite3.Cursor) -> dict[str, int]:
        cur.execute("DELETE FROM silver_transactions_clean")
        cur.execute(
            """
            INSERT INTO silver_transactions_clean (
                tx_id, tx_date, store_id, region, category,
                amount_usd, risk_score, risk_band, latency_ms, is_anomaly
            )
            SELECT
                tx_id,
                tx_date,
                COALESCE(store_id, 'STR-UNKNOWN'),
                region,
                category,
                amount_usd,
                risk_score,
                CASE
                    WHEN risk_score >= 0.80 THEN 'CRITICAL'
                    WHEN risk_score >= 0.55 THEN 'ELEVATED'
                    ELSE 'NOMINAL'
                END AS risk_band,
                latency_ms,
                is_anomaly
            FROM bronze_pos_events
            """
        )
        silver_tx_count = cur.rowcount

        cur.execute("DELETE FROM silver_customer_accounts")
        cur.execute(
            """
            INSERT INTO silver_customer_accounts (
                record_id, account_id, signup_cohort, segment, period_index,
                base_mrr_vnd, expansion_vnd, net_mrr_vnd, is_churned
            )
            SELECT
                record_id,
                account_id,
                signup_cohort,
                segment,
                period_index,
                mrr_vnd,
                expansion_vnd,
                CASE WHEN is_churned = 1 THEN 0.0 ELSE mrr_vnd + expansion_vnd END,
                is_churned
            FROM bronze_saas_subscriptions
            """
        )
        silver_acct_count = cur.rowcount

        cur.execute("DELETE FROM gold_regional_revenue_mart")
        cur.execute(
            """
            INSERT INTO gold_regional_revenue_mart (
                region, category, tx_count, gross_volume_usd,
                avg_ticket_usd, anomaly_count, avg_latency_ms
            )
            SELECT
                region,
                category,
                COUNT(*) AS tx_count,
                ROUND(SUM(amount_usd), 2) AS gross_volume_usd,
                ROUND(AVG(amount_usd), 2) AS avg_ticket_usd,
                SUM(is_anomaly) AS anomaly_count,
                ROUND(AVG(latency_ms), 2) AS avg_latency_ms
            FROM silver_transactions_clean
            GROUP BY region, category
            """
        )
        gold_rev_count = cur.rowcount

        cur.execute("DELETE FROM gold_nrr_cohort_mart")
        cur.execute(
            """
            INSERT INTO gold_nrr_cohort_mart (
                signup_cohort, segment, accounts, base_mrr_vnd,
                expansion_vnd, net_mrr_vnd, nrr_pct
            )
            SELECT
                signup_cohort,
                segment,
                COUNT(DISTINCT account_id) AS accounts,
                ROUND(SUM(base_mrr_vnd), 0) AS base_mrr_vnd,
                ROUND(SUM(expansion_vnd), 0) AS expansion_vnd,
                ROUND(SUM(net_mrr_vnd), 0) AS net_mrr_vnd,
                ROUND(
                    100.0 * SUM(net_mrr_vnd) / NULLIF(SUM(base_mrr_vnd), 0),
                    2
                ) AS nrr_pct
            FROM silver_customer_accounts
            GROUP BY signup_cohort, segment
            """
        )
        gold_nrr_count = cur.rowcount

        return {
            "silver_transactions_clean": silver_tx_count,
            "silver_customer_accounts": silver_acct_count,
            "gold_regional_revenue_mart": gold_rev_count,
            "gold_nrr_cohort_mart": gold_nrr_count,
        }

    def execute_readonly_sql(self, raw_sql: str, max_rows: int = 500) -> dict[str, Any]:
        """Executes a guarded read-only SELECT/WITH SQL query and returns results + EXPLAIN QUERY PLAN."""
        safe_sql = validate_readonly_sql(raw_sql)
        effective_limit = max(1, min(int(max_rows), 1000))

        with self._lock:
            t0 = time.perf_counter()
            self._conn.set_authorizer(_sqlite_readonly_authorizer)
            try:
                cur = self._conn.cursor()

                # Capture real SQLite EXPLAIN QUERY PLAN
                try:
                    cur.execute(f"EXPLAIN QUERY PLAN {safe_sql}")
                    plan_rows = [
                        {
                            "id": int(r[0]),
                            "parent": int(r[1]),
                            "detail": str(r[3]),
                        }
                        for r in cur.fetchall()
                    ]
                except sqlite3.DatabaseError as exc:
                    msg = str(exc)
                    if "not authorized" in msg.lower():
                        raise SqlGuardViolationError(
                            f"SQLite C-engine authorizer denied query: {msg}"
                        ) from exc
                    raise SqlExecutionError(f"SQL syntax/execution error: {msg}") from exc

                try:
                    cur.execute(safe_sql)
                    fetched = cur.fetchmany(effective_limit + 1)
                    columns = [desc[0] for desc in (cur.description or [])]
                except sqlite3.DatabaseError as exc:
                    msg = str(exc)
                    if "not authorized" in msg.lower():
                        raise SqlGuardViolationError(
                            f"SQLite C-engine authorizer denied query: {msg}"
                        ) from exc
                    raise SqlExecutionError(f"SQL execution error: {msg}") from exc
            finally:
                self._conn.set_authorizer(None)

            elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)
            truncated = len(fetched) > effective_limit
            trimmed = fetched[:effective_limit]
            rows = [{col: row[idx] for idx, col in enumerate(columns)} for row in trimmed]

            # Cost & partition pruning estimate from EXPLAIN QUERY PLAN details
            plan_text = " ".join(p["detail"].upper() for p in plan_rows)
            uses_index = "USING INDEX" in plan_text or "SEARCH " in plan_text
            pruning_ratio = 0.72 if uses_index else (0.35 if "WHERE" in safe_sql.upper() else 0.0)
            est_scan_rows = max(len(rows), int(round(max(len(rows), 600) * (1.0 - pruning_ratio))))
            mem_mb = round(max(0.08, (est_scan_rows * max(1, len(columns)) * 12) / (1024 * 1024)), 3)

            return {
                "columns": columns,
                "rows": rows,
                "row_count": len(rows),
                "truncated": truncated,
                "limit_applied": effective_limit,
                "execution_ms": elapsed_ms,
                "query_plan": plan_rows,
                "cost_estimate": {
                    "estimated_scan_rows": est_scan_rows,
                    "partition_pruning_ratio": pruning_ratio,
                    "memory_footprint_mb": mem_mb,
                },
            }

    def get_medallion_lineage(self) -> dict[str, Any]:
        """Returns live Medallion Bronze/Silver/Gold catalog tables, column schemas, null rates & DAG edges."""
        with self._lock:
            self._conn.set_authorizer(None)
            cur = self._conn.cursor()

            tables_payload: list[dict[str, Any]] = []
            for spec in MEDALLION_TABLES:
                cur.execute(f"SELECT COUNT(*) FROM {spec.name}")
                row_count = int(cur.fetchone()[0])

                cur.execute(f"PRAGMA table_info({spec.name})")
                raw_cols = cur.fetchall()

                cols_payload: list[dict[str, Any]] = []
                null_rates: list[float] = []
                for col in raw_cols:
                    col_name = str(col["name"])
                    col_type = str(col["type"] or "TEXT")
                    is_pk = bool(col["pk"])
                    if row_count > 0:
                        cur.execute(
                            f"SELECT COUNT(*) FROM {spec.name} WHERE {col_name} IS NULL"
                        )
                        null_cnt = int(cur.fetchone()[0])
                        null_pct = round((null_cnt / row_count) * 100.0, 2)
                    else:
                        null_pct = 0.0
                    null_rates.append(null_pct)
                    cols_payload.append(
                        {
                            "name": col_name,
                            "type": col_type,
                            "is_pk": is_pk,
                            "null_rate_pct": null_pct,
                        }
                    )

                avg_null = round(sum(null_rates) / max(1, len(null_rates)), 2)
                tables_payload.append(
                    {
                        "id": spec.id,
                        "name": spec.name,
                        "layer": spec.layer,
                        "kind": spec.kind,
                        "description": spec.description,
                        "row_count": row_count,
                        "null_rate_pct": avg_null,
                        "quality_grade": _grade_null_rate(avg_null),
                        "partition_key": spec.partition_key,
                        "refresh_sla_sec": spec.refresh_sla_sec,
                        "columns": cols_payload,
                    }
                )

            table_ids = [t["id"] for t in tables_payload]
            is_acyclic, topo_order = compute_topological_order(table_ids, list(MEDALLION_EDGES))

            return {
                "layers": ["bronze", "silver", "gold"],
                "tables": tables_payload,
                "edges": [
                    {
                        "id": e.id,
                        "source": e.source,
                        "target": e.target,
                        "transform": e.transform,
                        "edge_type": e.edge_type,
                    }
                    for e in MEDALLION_EDGES
                ],
                "topological_order": topo_order,
                "is_acyclic": is_acyclic,
            }

    def refresh_materialized_marts(self) -> dict[str, Any]:
        """Recomputes Silver & Gold materialized marts from Bronze inside an atomic SQLite transaction."""
        with self._lock:
            self._conn.set_authorizer(None)
            t0 = time.perf_counter()
            cur = self._conn.cursor()
            counts = self._rebuild_silver_and_gold(cur)
            self._conn.commit()
            duration_ms = round((time.perf_counter() - t0) * 1000.0, 2)
            return {
                "status": "COMPLETED",
                "refreshed_tables": counts,
                "duration_ms": duration_ms,
                "refreshed_at": datetime.now(timezone.utc).isoformat(),
            }


def _detect_delimiter(sample_line: str) -> str:
    candidates = [",", ";", "\t"]
    best = ","
    best_count = -1
    for delim in candidates:
        cnt = sample_line.count(delim)
        if cnt > best_count:
            best = delim
            best_count = cnt
    return best


def _is_bool_token(val: str) -> bool:
    return val.lower() in {"true", "false", "yes", "no"}


def profile_csv_content(csv_content: str, table_name: str = "uploaded_dataset") -> dict[str, Any]:
    """Parses raw CSV text, infers column schema & statistics, and flags data quality anomalies."""
    t0 = time.perf_counter()
    if not csv_content or not csv_content.strip():
        raise CsvProfilingError("CSV content must not be empty.")

    cleaned = csv_content.lstrip("\ufeff").strip()
    lines = [ln for ln in cleaned.splitlines() if ln.strip()]
    if len(lines) < 2:
        raise CsvProfilingError("CSV must contain a header row and at least one data row.")

    delimiter = _detect_delimiter(lines[0])
    reader = csv.reader(io.StringIO(cleaned), delimiter=delimiter)
    parsed_rows = [row for row in reader if any(cell.strip() for cell in row)]
    if len(parsed_rows) < 2:
        raise CsvProfilingError("CSV contains no valid data records.")

    raw_headers = parsed_rows[0]
    headers = [
        re.sub(r"[^a-zA-Z0-9_]+", "_", h.strip()).strip("_").lower() or f"col_{idx + 1}"
        for idx, h in enumerate(raw_headers)
    ]
    data_rows = parsed_rows[1:]
    row_count = len(data_rows)
    col_count = len(headers)

    # Detect exact duplicate rows
    seen_tuples: set[tuple[str, ...]] = set()
    duplicate_row_count = 0
    for row in data_rows:
        norm_tuple = tuple((row[i].strip() if i < len(row) else "") for i in range(col_count))
        if norm_tuple in seen_tuples:
            duplicate_row_count += 1
        else:
            seen_tuples.add(norm_tuple)

    columns_profile: list[dict[str, Any]] = []
    anomalies: list[dict[str, Any]] = []

    if duplicate_row_count > 0:
        anomalies.append(
            {
                "column": "*",
                "code": "DUPLICATE_ROWS",
                "severity": "warning",
                "message": f"Detected {duplicate_row_count} exact duplicate row(s) in CSV payload.",
            }
        )

    for c_idx, col_name in enumerate(headers):
        raw_vals = [row[c_idx].strip() if c_idx < len(row) else "" for row in data_rows]
        non_null = [v for v in raw_vals if v != "" and v.lower() not in {"null", "none", "na", "n/a"}]
        null_count = row_count - len(non_null)
        null_rate_pct = round((null_count / row_count) * 100.0, 2)
        distinct_count = len(set(non_null))

        int_hits = sum(1 for v in non_null if INT_PATTERN.match(v))
        float_hits = sum(1 for v in non_null if INT_PATTERN.match(v) or FLOAT_PATTERN.match(v))
        bool_hits = sum(1 for v in non_null if _is_bool_token(v))
        date_hits = sum(1 for v in non_null if DATE_PATTERN.match(v))

        n_valid = len(non_null)
        inferred_type = "string"
        numeric_vals: list[float] = []

        if n_valid > 0:
            if int_hits == n_valid:
                inferred_type = "integer"
                numeric_vals = [float(int(v)) for v in non_null]
            elif float_hits == n_valid:
                inferred_type = "float"
                numeric_vals = [float(v) for v in non_null]
            elif bool_hits == n_valid:
                inferred_type = "boolean"
            elif date_hits == n_valid:
                inferred_type = "date"
            elif float_hits / n_valid >= 0.75 and float_hits < n_valid:
                inferred_type = "string"
                anomalies.append(
                    {
                        "column": col_name,
                        "code": "MIXED_TYPE_VALUES",
                        "severity": "warning",
                        "message": (
                            f"Column '{col_name}' is {round((float_hits / n_valid) * 100, 1)}% numeric "
                            f"but contains {n_valid - float_hits} non-numeric string value(s)."
                        ),
                    }
                )

        min_val: Any = None
        max_val: Any = None
        mean_val: float | None = None

        if numeric_vals:
            min_num = min(numeric_vals)
            max_num = max(numeric_vals)
            min_val = int(min_num) if inferred_type == "integer" else round(min_num, 4)
            max_val = int(max_num) if inferred_type == "integer" else round(max_num, 4)
            mean_val = round(sum(numeric_vals) / len(numeric_vals), 4)

            if len(numeric_vals) >= 6:
                stdev = statistics.pstdev(numeric_vals)
                if stdev > 0:
                    outliers = [x for x in numeric_vals if abs(x - mean_val) > 2.5 * stdev]
                    if outliers:
                        anomalies.append(
                            {
                                "column": col_name,
                                "code": "NUMERIC_OUTLIERS",
                                "severity": "info",
                                "message": (
                                    f"Detected {len(outliers)} numeric outlier(s) exceeding 2.5 sigma "
                                    f"(max={max_val}, mean={mean_val})."
                                ),
                            }
                        )
        elif non_null:
            min_val = min(non_null)
            max_val = max(non_null)

        if null_rate_pct >= 20.0:
            anomalies.append(
                {
                    "column": col_name,
                    "code": "HIGH_NULL_RATE",
                    "severity": "critical" if null_rate_pct >= 50.0 else "warning",
                    "message": f"Column '{col_name}' has {null_rate_pct}% null values.",
                }
            )

        if row_count > 1 and distinct_count <= 1:
            anomalies.append(
                {
                    "column": col_name,
                    "code": "CONSTANT_COLUMN",
                    "severity": "info",
                    "message": f"Column '{col_name}' has zero variance (distinct_count={distinct_count}).",
                }
            )

        columns_profile.append(
            {
                "name": col_name,
                "inferred_type": inferred_type,
                "null_count": null_count,
                "null_rate_pct": null_rate_pct,
                "distinct_count": distinct_count,
                "min": min_val,
                "max": max_val,
                "mean": mean_val,
                "sample_values": non_null[:5],
            }
        )

    avg_null_pct = sum(c["null_rate_pct"] for c in columns_profile) / max(1, col_count)
    penalty = (
        avg_null_pct * 0.65
        + sum(8.0 if a["severity"] == "critical" else 4.0 if a["severity"] == "warning" else 1.5 for a in anomalies)
    )
    quality_score = round(max(0.0, min(100.0, 100.0 - penalty)), 1)
    if math.isnan(quality_score):
        quality_score = 0.0

    parse_ms = round((time.perf_counter() - t0) * 1000.0, 2)
    safe_table = re.sub(r"[^a-zA-Z0-9_]+", "_", table_name.strip()).strip("_").lower() or "uploaded_dataset"

    return {
        "table_name": safe_table,
        "row_count": row_count,
        "column_count": col_count,
        "delimiter": delimiter,
        "quality_score": quality_score,
        "parse_ms": parse_ms,
        "columns": columns_profile,
        "anomalies": anomalies,
    }
