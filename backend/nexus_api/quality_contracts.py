"""Deterministic Data Quality & Freshness SLA Contract Engine (dbt-test / Great Expectations)."""

from __future__ import annotations

import math
import time
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field

RuleType = Literal[
    "not_null",
    "unique",
    "accepted_range",
    "referential_integrity",
    "freshness_sla_minutes",
]
AssertionStatus = Literal["PASS", "WARN", "CRITICAL_FAIL"]
OverallHealthStatus = Literal["HEALTHY", "DEGRADED", "CRITICAL"]


class ChaosInjectionFlags(BaseModel):
    """Deterministic chaos fault injectors for testing contract enforcement."""

    null_store_id_pct: float = Field(
        default=0.0,
        ge=0.0,
        le=100.0,
        description="Percentage of bronze_orders rows with NULL store_id (e.g. 1.8).",
    )
    duplicate_voucher_count: int = Field(
        default=0,
        ge=0,
        le=200_000,
        description="Number of duplicate voucher redemption keys injected into silver_vouchers.",
    )
    kafka_cdc_lag_minutes: float = Field(
        default=0.0,
        ge=0.0,
        le=1440.0,
        description="Additional Kafka CDC pipeline lag in minutes (e.g. 45.0).",
    )
    out_of_range_amount_count: int = Field(
        default=0,
        ge=0,
        le=200_000,
        description="Rows violating accepted numeric bounds on amount_usd / discount_pct.",
    )
    orphan_fk_count: int = Field(
        default=0,
        ge=0,
        le=200_000,
        description="Orphan foreign-key rows failing referential integrity checks.",
    )


class CustomContractRule(BaseModel):
    """Optional caller-supplied custom assertion evaluated alongside core retail contracts."""

    rule_id: str = Field(..., min_length=2, max_length=80)
    table: str = Field(..., min_length=2, max_length=80)
    column: str = Field(..., min_length=1, max_length=80)
    rule_type: RuleType
    observed_value: float = Field(..., ge=0.0)
    warn_threshold: float = Field(default=0.1, ge=0.0)
    fail_threshold: float = Field(default=0.5, ge=0.0)
    failed_rows: int = Field(default=0, ge=0)
    min_value: float | None = None
    max_value: float | None = None
    reference_table: str | None = None
    reference_column: str | None = None
    sla_minutes: float | None = Field(default=None, ge=1.0)
    weight: float = Field(default=8.0, ge=1.0, le=30.0)


class QualityContractEvalRequest(BaseModel):
    """Payload for POST /api/v1/quality/evaluate-contracts."""

    dataset_scale: int = Field(
        default=100_000,
        ge=100,
        le=10_000_000,
        description="Total row volume for bronze_orders baseline scaling.",
    )
    chaos_flags: ChaosInjectionFlags = Field(default_factory=ChaosInjectionFlags)
    tables_filter: list[str] | None = Field(
        default=None,
        description="Optional subset of table names to evaluate.",
    )
    custom_rules: list[CustomContractRule] = Field(
        default_factory=list,
        max_length=25,
        description="Optional additional contract assertions to evaluate.",
    )


class AssertionEvaluationResult(BaseModel):
    rule_id: str
    table: str
    layer: Literal["bronze", "silver", "gold"]
    column: str
    rule_type: RuleType
    dbt_test_name: str
    status: AssertionStatus
    threshold_label: str
    observed_value: float
    observed_label: str
    failed_rows: int
    quarantined_rows: int
    sla_breached: bool
    weight: float
    penalty: float
    remediation_sql: str


class SlaBreachModel(BaseModel):
    table: str
    layer: Literal["bronze", "silver", "gold"]
    observed_lag_minutes: float
    sla_limit_minutes: float
    excess_minutes: float
    status: AssertionStatus


class TableQualitySummaryModel(BaseModel):
    table: str
    layer: Literal["bronze", "silver", "gold"]
    row_count: int
    trust_score: float
    freshness_lag_minutes: float
    sla_limit_minutes: float
    passed_assertions: int
    warn_assertions: int
    failed_assertions: int
    quarantined_rows: int
    status: AssertionStatus


class QualityTimelinePointModel(BaseModel):
    hour_index: int
    hour_label: str
    trust_score: float
    freshness_lag_minutes: float
    quarantined_rows: int
    sla_breached: bool


class QualityContractEvalResponse(BaseModel):
    data_trust_score: float
    overall_status: OverallHealthStatus
    total_rules: int
    passed_rules: int
    warn_rules: int
    failed_rules: int
    total_quarantined_rows: int
    sla_breach_count: int
    sla_breaches: list[SlaBreachModel]
    table_summaries: list[TableQualitySummaryModel]
    assertions: list[AssertionEvaluationResult]
    timeline_24h: list[QualityTimelinePointModel]
    dbt_schema_yaml: str
    evaluated_at: str
    evaluation_ms: float


_TABLE_LAYER_MAP: dict[str, Literal["bronze", "silver", "gold"]] = {
    "bronze_orders": "bronze",
    "silver_vouchers": "silver",
    "gold_store_kpis": "gold",
}


def _infer_layer(table_name: str) -> Literal["bronze", "silver", "gold"]:
    if table_name in _TABLE_LAYER_MAP:
        return _TABLE_LAYER_MAP[table_name]
    lower = table_name.lower()
    if lower.startswith("bronze"):
        return "bronze"
    if lower.startswith("gold"):
        return "gold"
    return "silver"


def _status_from_thresholds(
    observed: float, warn_threshold: float, fail_threshold: float
) -> AssertionStatus:
    if observed >= fail_threshold and fail_threshold > 0:
        return "CRITICAL_FAIL"
    if fail_threshold == 0 and observed > 0:
        return "CRITICAL_FAIL"
    if observed > warn_threshold:
        return "WARN"
    return "PASS"


def _penalty_for_status(status: AssertionStatus, weight: float) -> float:
    if status == "CRITICAL_FAIL":
        return round(weight, 2)
    if status == "WARN":
        return round(weight * 0.45, 2)
    return 0.0


def generate_dbt_schema_yaml(
    *,
    trust_score: float,
    total_quarantined_rows: int,
    evaluated_at: str,
    table_summaries: list[TableQualitySummaryModel],
) -> str:
    """Generates a deterministic dbt v2 schema.yml contract file matching active rules."""
    summary_by_table = {t.table: t for t in table_summaries}
    lines: list[str] = [
        "# Auto-generated by NEXUS LAKE v5.0 Data Quality & SLA Contract Engine",
        f"# Evaluated At: {evaluated_at}",
        f"# Overall Data Trust Score: {trust_score:.1f}% | Quarantined Rows: {total_quarantined_rows:,}",
        "version: 2",
        "",
        "sources:",
        "  - name: retail_lakehouse_raw",
        "    database: nexus_lake",
        "    schema: bronze",
        "    loaded_at_field: ingested_at_utc",
        "    freshness:",
        "      warn_after: {count: 10, period: minute}",
        "      error_after: {count: 15, period: minute}",
        "    tables:",
        "      - name: bronze_orders",
        "        description: Raw POS & omni-channel retail orders streamed via Kafka CDC.",
        "        columns:",
        "          - name: order_id",
        "            tests:",
        "              - not_null",
        "              - unique",
        "          - name: store_id",
        "            tests:",
        "              - not_null:",
        "                  config:",
        "                    severity: error",
        "          - name: amount_usd",
        "            tests:",
        "              - dbt_utils.accepted_range:",
        "                  min_value: 0.5",
        "                  max_value: 25000.0",
        "                  inclusive: true",
        "",
        "models:",
    ]

    if "silver_vouchers" in summary_by_table or not summary_by_table:
        lines.extend(
            [
                "  - name: silver_vouchers",
                "    description: Deduplicated voucher redemption ledger with anti double-spend enforcement.",
                "    meta:",
                "      freshness_sla_minutes: 10",
                "      contract_enforced: true",
                "    columns:",
                "      - name: redemption_key",
                "        tests:",
                "          - not_null",
                "          - unique:",
                "              config:",
                "                severity: error",
                "      - name: order_id",
                "        tests:",
                "          - relationships:",
                "              to: source('retail_lakehouse_raw', 'bronze_orders')",
                "              field: order_id",
                "      - name: discount_pct",
                "        tests:",
                "          - dbt_utils.accepted_range:",
                "              min_value: 0",
                "              max_value: 80",
                "              inclusive: true",
                "",
            ]
        )

    if "gold_store_kpis" in summary_by_table or not summary_by_table:
        lines.extend(
            [
                "  - name: gold_store_kpis",
                "    description: Executive store-fleet KPI mart spanning 720 Con Cung retail branches.",
                "    meta:",
                "      freshness_sla_minutes: 20",
                "      contract_enforced: true",
                "    columns:",
                "      - name: store_id",
                "        tests:",
                "          - not_null",
                "          - unique",
                "          - relationships:",
                "              to: source('retail_lakehouse_raw', 'bronze_orders')",
                "              field: store_id",
                "      - name: gross_margin_pct",
                "        tests:",
                "          - dbt_utils.accepted_range:",
                "              min_value: 5",
                "              max_value: 65",
                "              inclusive: true",
            ]
        )

    return "\n".join(lines) + "\n"


def _build_timeline_24h(
    *,
    current_trust_score: float,
    current_max_lag: float,
    total_quarantined_rows: int,
    has_sla_breach: bool,
) -> list[QualityTimelinePointModel]:
    """Produces a deterministic 24-hour hourly freshness & quality health timeline."""
    points: list[QualityTimelinePointModel] = []
    # Deterministic minor organic jitter on historical healthy hours (00:00..22:00)
    # while live hour (23:00 / NOW) reflects active contract evaluation cleanly.
    for hour in range(24):
        label = "NOW" if hour == 23 else f"{hour:02d}:00"
        if hour < 22:
            wave = math.sin((hour + 1) * 0.65)
            hist_lag = round(3.4 + abs(wave) * 2.1, 1)
            hist_trust = 100.0 if (hour % 7 != 3) else 99.6
            points.append(
                QualityTimelinePointModel(
                    hour_index=hour,
                    hour_label=label,
                    trust_score=hist_trust,
                    freshness_lag_minutes=hist_lag,
                    quarantined_rows=0,
                    sla_breached=False,
                )
            )
        elif hour == 22:
            # Ramp-in transition when active incident is present
            if current_trust_score < 100.0 or has_sla_breach:
                ramp_trust = round(100.0 - (100.0 - current_trust_score) * 0.35, 1)
                ramp_lag = round(4.2 + max(0.0, current_max_lag - 5.1) * 0.38, 1)
                ramp_quarantine = int(round(total_quarantined_rows * 0.25))
                points.append(
                    QualityTimelinePointModel(
                        hour_index=hour,
                        hour_label=label,
                        trust_score=ramp_trust,
                        freshness_lag_minutes=ramp_lag,
                        quarantined_rows=ramp_quarantine,
                        sla_breached=ramp_lag > 15.0,
                    )
                )
            else:
                points.append(
                    QualityTimelinePointModel(
                        hour_index=hour,
                        hour_label=label,
                        trust_score=100.0,
                        freshness_lag_minutes=3.8,
                        quarantined_rows=0,
                        sla_breached=False,
                    )
                )
        else:
            points.append(
                QualityTimelinePointModel(
                    hour_index=hour,
                    hour_label=label,
                    trust_score=round(current_trust_score, 1),
                    freshness_lag_minutes=round(current_max_lag, 1),
                    quarantined_rows=total_quarantined_rows,
                    sla_breached=has_sla_breach,
                )
            )
    return points


def evaluate_quality_contracts(
    payload: QualityContractEvalRequest,
) -> QualityContractEvalResponse:
    """Runs deterministic dbt-test / Great Expectations contract rules over retail lakehouse tables."""
    t0 = time.perf_counter()
    chaos = payload.chaos_flags
    bronze_rows = int(payload.dataset_scale)
    silver_rows = max(50, int(round(bronze_rows * 0.324)))
    gold_rows = 720

    # Derive fault metrics cleanly from chaos flags
    null_store_pct = round(chaos.null_store_id_pct, 2)
    null_store_rows = int(round(bronze_rows * (null_store_pct / 100.0)))

    dup_voucher_rows = int(chaos.duplicate_voucher_count)
    # Duplicate voucher abuse also spills stacked discounts beyond 80% ceiling
    stacked_discount_breaches = (
        max(1, int(round(dup_voucher_rows * 0.092))) if dup_voucher_rows > 0 else 0
    )
    range_amount_breaches = int(chaos.out_of_range_amount_count)

    # Null store_ids cascade into broken gold_store_kpis referential integrity
    cascaded_store_orphans = (
        max(1, int(round(null_store_rows * 0.12))) if null_store_rows > 0 else 0
    )
    voucher_fk_orphans = int(chaos.orphan_fk_count)

    # Freshness lags (minutes)
    bronze_lag = round(3.2 + chaos.kafka_cdc_lag_minutes, 1)
    silver_lag = round(
        2.4 + (chaos.kafka_cdc_lag_minutes * 1.08 if chaos.kafka_cdc_lag_minutes > 0 else 0.0),
        1,
    )
    gold_lag = round(
        5.1 + (chaos.kafka_cdc_lag_minutes * 1.15 if chaos.kafka_cdc_lag_minutes > 0 else 0.0),
        1,
    )

    all_assertions: list[AssertionEvaluationResult] = []

    def add_assertion(
        *,
        rule_id: str,
        table: str,
        column: str,
        rule_type: RuleType,
        dbt_test_name: str,
        status: AssertionStatus,
        threshold_label: str,
        observed_value: float,
        observed_label: str,
        failed_rows: int,
        quarantined_rows: int,
        sla_breached: bool,
        weight: float,
        remediation_sql: str,
    ) -> None:
        all_assertions.append(
            AssertionEvaluationResult(
                rule_id=rule_id,
                table=table,
                layer=_infer_layer(table),
                column=column,
                rule_type=rule_type,
                dbt_test_name=dbt_test_name,
                status=status,
                threshold_label=threshold_label,
                observed_value=round(observed_value, 4),
                observed_label=observed_label,
                failed_rows=failed_rows,
                quarantined_rows=quarantined_rows,
                sla_breached=sla_breached,
                weight=weight,
                penalty=_penalty_for_status(status, weight),
                remediation_sql=remediation_sql,
            )
        )

    # 1. bronze_orders.store_id -> not_null
    store_null_status: AssertionStatus = (
        "CRITICAL_FAIL"
        if null_store_pct >= 0.5
        else "WARN"
        if null_store_pct > 0.0
        else "PASS"
    )
    add_assertion(
        rule_id="dq-bronze-orders-store-id-not-null",
        table="bronze_orders",
        column="store_id",
        rule_type="not_null",
        dbt_test_name="not_null(bronze_orders.store_id)",
        status=store_null_status,
        threshold_label="0.00% NULL (warn > 0%, fail >= 0.50%)",
        observed_value=null_store_pct,
        observed_label=f"{null_store_pct:.2f}% NULL ({null_store_rows:,} rows)",
        failed_rows=null_store_rows,
        quarantined_rows=null_store_rows,
        sla_breached=False,
        weight=12.5,
        remediation_sql=(
            "SELECT region, COUNT(*) AS tx_count, SUM(CASE WHEN is_anomaly THEN 1 ELSE 0 END) AS anomalies "
            "FROM transactions GROUP BY region ORDER BY tx_count DESC LIMIT 50;"
        ),
    )

    # 2. bronze_orders.order_id -> unique
    add_assertion(
        rule_id="dq-bronze-orders-order-id-unique",
        table="bronze_orders",
        column="order_id",
        rule_type="unique",
        dbt_test_name="unique(bronze_orders.order_id)",
        status="PASS",
        threshold_label="0 duplicate primary keys",
        observed_value=0.0,
        observed_label="0 duplicates (100% unique)",
        failed_rows=0,
        quarantined_rows=0,
        sla_breached=False,
        weight=8.0,
        remediation_sql=(
            "SELECT tx_id, COUNT(*) AS dup_count FROM transactions "
            "GROUP BY tx_id HAVING COUNT(*) > 1 LIMIT 50;"
        ),
    )

    # 3. bronze_orders.amount_usd -> accepted_range [0.50, 25000.00]
    amt_status: AssertionStatus = (
        "CRITICAL_FAIL"
        if range_amount_breaches >= 25
        else "WARN"
        if range_amount_breaches > 0
        else "PASS"
    )
    add_assertion(
        rule_id="dq-bronze-orders-amount-range",
        table="bronze_orders",
        column="amount_usd",
        rule_type="accepted_range",
        dbt_test_name="dbt_utils.accepted_range(amount_usd, [0.50, 25000])",
        status=amt_status,
        threshold_label="0.50 <= amount_usd <= 25,000.00",
        observed_value=float(range_amount_breaches),
        observed_label=(
            f"{range_amount_breaches:,} out-of-range rows"
            if range_amount_breaches > 0
            else "100% within [$0.50, $25,000]"
        ),
        failed_rows=range_amount_breaches,
        quarantined_rows=range_amount_breaches,
        sla_breached=False,
        weight=7.5,
        remediation_sql=(
            "SELECT tx_id, region, amount_usd, risk_score FROM transactions "
            "WHERE amount_usd > 4000 ORDER BY amount_usd DESC LIMIT 50;"
        ),
    )

    # 4. bronze_orders freshness_sla_minutes <= 15
    bronze_fresh_status: AssertionStatus = (
        "CRITICAL_FAIL"
        if bronze_lag > 15.0
        else "WARN"
        if bronze_lag > 10.0
        else "PASS"
    )
    add_assertion(
        rule_id="dq-bronze-orders-freshness-sla",
        table="bronze_orders",
        column="ingested_at_utc",
        rule_type="freshness_sla_minutes",
        dbt_test_name="source_freshness(bronze_orders <= 15m)",
        status=bronze_fresh_status,
        threshold_label="SLA <= 15.0 min (warn > 10m)",
        observed_value=bronze_lag,
        observed_label=f"{bronze_lag:.1f} min CDC lag",
        failed_rows=0,
        quarantined_rows=0,
        sla_breached=bronze_lag > 15.0,
        weight=9.5,
        remediation_sql=(
            "SELECT region, COUNT(*) AS recent_rows, ROUND(AVG(latency_ms), 1) AS avg_latency_ms "
            "FROM transactions GROUP BY region ORDER BY avg_latency_ms DESC;"
        ),
    )

    # 5. silver_vouchers.redemption_key -> unique (double-spending prevention)
    voucher_dup_status: AssertionStatus = (
        "CRITICAL_FAIL"
        if dup_voucher_rows >= 10
        else "WARN"
        if dup_voucher_rows > 0
        else "PASS"
    )
    add_assertion(
        rule_id="dq-silver-vouchers-redemption-unique",
        table="silver_vouchers",
        column="redemption_key",
        rule_type="unique",
        dbt_test_name="unique(silver_vouchers.redemption_key)",
        status=voucher_dup_status,
        threshold_label="0 duplicate redemptions (anti double-spend)",
        observed_value=float(dup_voucher_rows),
        observed_label=(
            f"{dup_voucher_rows:,} duplicate redemptions"
            if dup_voucher_rows > 0
            else "0 double-spends detected"
        ),
        failed_rows=dup_voucher_rows,
        quarantined_rows=dup_voucher_rows,
        sla_breached=False,
        weight=13.0,
        remediation_sql=(
            "SELECT voucher_code, COUNT(*) AS redemptions, ROUND(SUM(amount_usd), 2) AS volume_usd "
            "FROM transactions WHERE voucher_code IS NOT NULL "
            "GROUP BY voucher_code ORDER BY redemptions DESC;"
        ),
    )

    # 6. silver_vouchers.discount_pct -> accepted_range [0, 80]
    disc_status: AssertionStatus = (
        "CRITICAL_FAIL"
        if stacked_discount_breaches >= 25
        else "WARN"
        if stacked_discount_breaches > 0
        else "PASS"
    )
    add_assertion(
        rule_id="dq-silver-vouchers-discount-range",
        table="silver_vouchers",
        column="discount_pct",
        rule_type="accepted_range",
        dbt_test_name="dbt_utils.accepted_range(discount_pct, [0, 80])",
        status=disc_status,
        threshold_label="0% <= discount_pct <= 80%",
        observed_value=float(stacked_discount_breaches),
        observed_label=(
            f"{stacked_discount_breaches:,} stacked >80% violations"
            if stacked_discount_breaches > 0
            else "100% within [0%, 80%]"
        ),
        failed_rows=stacked_discount_breaches,
        quarantined_rows=stacked_discount_breaches,
        sla_breached=False,
        weight=7.5,
        remediation_sql=(
            "SELECT category, voucher_code, COUNT(*) AS tx_count, ROUND(AVG(risk_score), 3) AS avg_risk "
            "FROM transactions WHERE category = 'VOUCHER_REDEEM' "
            "GROUP BY category, voucher_code ORDER BY avg_risk DESC;"
        ),
    )

    # 7. silver_vouchers.order_id -> referential_integrity -> bronze_orders.order_id
    voucher_fk_status: AssertionStatus = (
        "CRITICAL_FAIL"
        if voucher_fk_orphans >= 10
        else "WARN"
        if voucher_fk_orphans > 0
        else "PASS"
    )
    add_assertion(
        rule_id="dq-silver-vouchers-order-fk",
        table="silver_vouchers",
        column="order_id",
        rule_type="referential_integrity",
        dbt_test_name="relationships(silver_vouchers.order_id -> bronze_orders.order_id)",
        status=voucher_fk_status,
        threshold_label="100% FK match to bronze_orders.order_id",
        observed_value=float(voucher_fk_orphans),
        observed_label=(
            f"{voucher_fk_orphans:,} orphan voucher records"
            if voucher_fk_orphans > 0
            else "100.0% referential integrity"
        ),
        failed_rows=voucher_fk_orphans,
        quarantined_rows=voucher_fk_orphans,
        sla_breached=False,
        weight=7.0,
        remediation_sql=(
            "SELECT tx_id, voucher_code, amount_usd FROM transactions "
            "WHERE voucher_code IS NOT NULL ORDER BY amount_usd DESC LIMIT 50;"
        ),
    )

    # 8. silver_vouchers freshness_sla_minutes <= 10
    silver_fresh_status: AssertionStatus = (
        "CRITICAL_FAIL"
        if silver_lag > 10.0
        else "WARN"
        if silver_lag > 7.5
        else "PASS"
    )
    add_assertion(
        rule_id="dq-silver-vouchers-freshness-sla",
        table="silver_vouchers",
        column="updated_at_utc",
        rule_type="freshness_sla_minutes",
        dbt_test_name="freshness_sla(silver_vouchers <= 10m)",
        status=silver_fresh_status,
        threshold_label="SLA <= 10.0 min (warn > 7.5m)",
        observed_value=silver_lag,
        observed_label=f"{silver_lag:.1f} min stream lag",
        failed_rows=0,
        quarantined_rows=0,
        sla_breached=silver_lag > 10.0,
        weight=8.5,
        remediation_sql=(
            "SELECT category, COUNT(*) AS rows_in_window, ROUND(AVG(latency_ms), 1) AS avg_ms "
            "FROM transactions GROUP BY category ORDER BY avg_ms DESC;"
        ),
    )

    # 9. gold_store_kpis.store_id -> not_null
    add_assertion(
        rule_id="dq-gold-store-kpis-store-id-not-null",
        table="gold_store_kpis",
        column="store_id",
        rule_type="not_null",
        dbt_test_name="not_null(gold_store_kpis.store_id)",
        status="PASS",
        threshold_label="0 NULL store identifiers across 720 branches",
        observed_value=0.0,
        observed_label="0 NULLs (720/720 branches)",
        failed_rows=0,
        quarantined_rows=0,
        sla_breached=False,
        weight=6.5,
        remediation_sql=(
            "SELECT region, COUNT(*) AS tx_count, ROUND(SUM(amount_usd), 2) AS gross_volume_usd "
            "FROM transactions GROUP BY region ORDER BY gross_volume_usd DESC;"
        ),
    )

    # 10. gold_store_kpis.store_id -> referential_integrity -> bronze_orders.store_id
    store_fk_status: AssertionStatus = (
        "CRITICAL_FAIL"
        if cascaded_store_orphans >= 100
        else "WARN"
        if cascaded_store_orphans > 0
        else "PASS"
    )
    add_assertion(
        rule_id="dq-gold-store-kpis-store-fk",
        table="gold_store_kpis",
        column="store_id",
        rule_type="referential_integrity",
        dbt_test_name="relationships(gold_store_kpis.store_id -> bronze_orders.store_id)",
        status=store_fk_status,
        threshold_label="0 unmapped store KPI aggregations",
        observed_value=float(cascaded_store_orphans),
        observed_label=(
            f"{cascaded_store_orphans:,} orphaned store rollups"
            if cascaded_store_orphans > 0
            else "100.0% FK store join parity"
        ),
        failed_rows=cascaded_store_orphans,
        quarantined_rows=cascaded_store_orphans,
        sla_breached=False,
        weight=7.0,
        remediation_sql=(
            "SELECT store_id, region, COUNT(*) AS tx_count, ROUND(SUM(amount_usd), 2) AS gmv_usd "
            "FROM transactions GROUP BY store_id, region ORDER BY gmv_usd DESC LIMIT 40;"
        ),
    )

    # 11. gold_store_kpis.gross_margin_pct -> accepted_range [5, 65]
    margin_breaches = 1 if (dup_voucher_rows >= 200 and null_store_rows >= 500) else 0
    margin_status: AssertionStatus = "WARN" if margin_breaches > 0 else "PASS"
    add_assertion(
        rule_id="dq-gold-store-kpis-margin-range",
        table="gold_store_kpis",
        column="gross_margin_pct",
        rule_type="accepted_range",
        dbt_test_name="dbt_utils.accepted_range(gross_margin_pct, [5, 65])",
        status=margin_status,
        threshold_label="5.0% <= gross_margin_pct <= 65.0%",
        observed_value=float(margin_breaches),
        observed_label=(
            f"{margin_breaches} store margin anomaly"
            if margin_breaches > 0
            else "All 720 stores within [5%, 65%]"
        ),
        failed_rows=margin_breaches,
        quarantined_rows=margin_breaches,
        sla_breached=False,
        weight=5.5,
        remediation_sql=(
            "SELECT category, COUNT(*) AS tx_count, ROUND(AVG(amount_usd), 2) AS avg_ticket_usd "
            "FROM transactions GROUP BY category ORDER BY avg_ticket_usd DESC;"
        ),
    )

    # 12. gold_store_kpis freshness_sla_minutes <= 20
    gold_fresh_status: AssertionStatus = (
        "CRITICAL_FAIL"
        if gold_lag > 20.0
        else "WARN"
        if gold_lag > 15.0
        else "PASS"
    )
    add_assertion(
        rule_id="dq-gold-store-kpis-freshness-sla",
        table="gold_store_kpis",
        column="materialized_at_utc",
        rule_type="freshness_sla_minutes",
        dbt_test_name="freshness_sla(gold_store_kpis <= 20m)",
        status=gold_fresh_status,
        threshold_label="SLA <= 20.0 min (warn > 15m)",
        observed_value=gold_lag,
        observed_label=f"{gold_lag:.1f} min mart freshness lag",
        failed_rows=0,
        quarantined_rows=0,
        sla_breached=gold_lag > 20.0,
        weight=7.5,
        remediation_sql=(
            "SELECT region, COUNT(*) AS tx_count, ROUND(AVG(latency_ms), 2) AS avg_latency_ms "
            "FROM transactions GROUP BY region ORDER BY avg_latency_ms DESC;"
        ),
    )

    # Evaluate any caller-supplied custom rules
    for custom in payload.custom_rules:
        if custom.rule_type == "freshness_sla_minutes":
            sla_lim = custom.sla_minutes or custom.fail_threshold or 15.0
            warn_lim = min(sla_lim * 0.75, custom.warn_threshold or sla_lim * 0.75)
            status = (
                "CRITICAL_FAIL"
                if custom.observed_value > sla_lim
                else "WARN"
                if custom.observed_value > warn_lim
                else "PASS"
            )
            sla_breach = custom.observed_value > sla_lim
            thr_label = f"SLA <= {sla_lim:.1f} min"
            obs_label = f"{custom.observed_value:.1f} min lag"
            dbt_name = f"freshness_sla({custom.table} <= {sla_lim:g}m)"
        else:
            status = _status_from_thresholds(
                custom.observed_value, custom.warn_threshold, custom.fail_threshold
            )
            sla_breach = False
            if custom.rule_type == "accepted_range":
                thr_label = f"[{custom.min_value}, {custom.max_value}]"
                dbt_name = f"dbt_utils.accepted_range({custom.column})"
            elif custom.rule_type == "referential_integrity":
                ref = f"{custom.reference_table or 'parent'}.{custom.reference_column or custom.column}"
                thr_label = f"FK -> {ref}"
                dbt_name = f"relationships({custom.table}.{custom.column} -> {ref})"
            else:
                thr_label = f"warn > {custom.warn_threshold}, fail >= {custom.fail_threshold}"
                dbt_name = f"{custom.rule_type}({custom.table}.{custom.column})"
            obs_label = f"{custom.observed_value:g} ({custom.failed_rows:,} failed rows)"

        add_assertion(
            rule_id=custom.rule_id,
            table=custom.table,
            column=custom.column,
            rule_type=custom.rule_type,
            dbt_test_name=dbt_name,
            status=status,
            threshold_label=thr_label,
            observed_value=custom.observed_value,
            observed_label=obs_label,
            failed_rows=custom.failed_rows,
            quarantined_rows=custom.failed_rows,
            sla_breached=sla_breach,
            weight=custom.weight,
            remediation_sql=f"SELECT * FROM {custom.table} LIMIT 50;",
        )

    # Optional table subset filter
    if payload.tables_filter:
        allowed_tables = {t.strip().lower() for t in payload.tables_filter if t.strip()}
        filtered_assertions = [
            a for a in all_assertions if a.table.lower() in allowed_tables
        ]
    else:
        filtered_assertions = all_assertions

    total_weight = sum(a.weight for a in filtered_assertions) or 1.0
    total_penalty = sum(a.penalty for a in filtered_assertions)
    trust_score = round(max(0.0, min(100.0, 100.0 * (1.0 - total_penalty / total_weight))), 1)

    passed_rules = sum(1 for a in filtered_assertions if a.status == "PASS")
    warn_rules = sum(1 for a in filtered_assertions if a.status == "WARN")
    failed_rules = sum(1 for a in filtered_assertions if a.status == "CRITICAL_FAIL")
    total_quarantined = sum(a.quarantined_rows for a in filtered_assertions)

    # Build SLA breach list
    sla_limits = {
        "bronze_orders": (bronze_lag, 15.0, bronze_rows),
        "silver_vouchers": (silver_lag, 10.0, silver_rows),
        "gold_store_kpis": (gold_lag, 20.0, gold_rows),
    }

    sla_breaches: list[SlaBreachModel] = []
    for a in filtered_assertions:
        if a.rule_type == "freshness_sla_minutes" and a.sla_breached:
            limit_val = sla_limits.get(a.table, (a.observed_value, 15.0, 0))[1]
            sla_breaches.append(
                SlaBreachModel(
                    table=a.table,
                    layer=a.layer,
                    observed_lag_minutes=round(a.observed_value, 1),
                    sla_limit_minutes=limit_val,
                    excess_minutes=round(max(0.0, a.observed_value - limit_val), 1),
                    status=a.status,
                )
            )

    # Group per-table summaries
    seen_tables: list[str] = []
    for a in filtered_assertions:
        if a.table not in seen_tables:
            seen_tables.append(a.table)

    table_summaries: list[TableQualitySummaryModel] = []
    for tbl in seen_tables:
        tbl_rules = [a for a in filtered_assertions if a.table == tbl]
        t_weight = sum(a.weight for a in tbl_rules) or 1.0
        t_penalty = sum(a.penalty for a in tbl_rules)
        t_score = round(max(0.0, min(100.0, 100.0 * (1.0 - t_penalty / t_weight))), 1)
        t_pass = sum(1 for a in tbl_rules if a.status == "PASS")
        t_warn = sum(1 for a in tbl_rules if a.status == "WARN")
        t_fail = sum(1 for a in tbl_rules if a.status == "CRITICAL_FAIL")
        t_quar = sum(a.quarantined_rows for a in tbl_rules)
        lag_val, lim_val, r_cnt = sla_limits.get(tbl, (3.0, 15.0, 1000))
        t_status: AssertionStatus = (
            "CRITICAL_FAIL" if t_fail > 0 else "WARN" if t_warn > 0 else "PASS"
        )
        table_summaries.append(
            TableQualitySummaryModel(
                table=tbl,
                layer=_infer_layer(tbl),
                row_count=r_cnt,
                trust_score=t_score,
                freshness_lag_minutes=lag_val,
                sla_limit_minutes=lim_val,
                passed_assertions=t_pass,
                warn_assertions=t_warn,
                failed_assertions=t_fail,
                quarantined_rows=t_quar,
                status=t_status,
            )
        )

    overall_status: OverallHealthStatus = (
        "CRITICAL"
        if failed_rules > 0 or trust_score < 80.0
        else "DEGRADED"
        if warn_rules > 0 or trust_score < 98.0
        else "HEALTHY"
    )

    evaluated_at = datetime.now(timezone.utc).isoformat()
    max_lag = max((t.freshness_lag_minutes for t in table_summaries), default=3.2)
    timeline_24h = _build_timeline_24h(
        current_trust_score=trust_score,
        current_max_lag=max_lag,
        total_quarantined_rows=total_quarantined,
        has_sla_breach=len(sla_breaches) > 0,
    )
    dbt_yaml = generate_dbt_schema_yaml(
        trust_score=trust_score,
        total_quarantined_rows=total_quarantined,
        evaluated_at=evaluated_at,
        table_summaries=table_summaries,
    )
    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)

    return QualityContractEvalResponse(
        data_trust_score=trust_score,
        overall_status=overall_status,
        total_rules=len(filtered_assertions),
        passed_rules=passed_rules,
        warn_rules=warn_rules,
        failed_rules=failed_rules,
        total_quarantined_rows=total_quarantined,
        sla_breach_count=len(sla_breaches),
        sla_breaches=sla_breaches,
        table_summaries=table_summaries,
        assertions=filtered_assertions,
        timeline_24h=timeline_24h,
        dbt_schema_yaml=dbt_yaml,
        evaluated_at=evaluated_at,
        evaluation_ms=elapsed_ms,
    )
