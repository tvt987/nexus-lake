"""Integration & Unit Tests for Nexus Lake v5.0 Data Quality & Freshness SLA Contract Engine."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from nexus_api.main import create_app  # noqa: E402


@pytest.fixture()
def client() -> TestClient:
    app = create_app(db_path=":memory:")
    return TestClient(app)


def test_quality_contracts_clean_baseline_returns_100_trust_score(client: TestClient) -> None:
    resp = client.post("/api/v1/quality/evaluate-contracts", json={})
    assert resp.status_code == 200
    body = resp.json()

    assert body["data_trust_score"] == 100.0
    assert body["overall_status"] == "HEALTHY"
    assert body["total_rules"] == 12
    assert body["passed_rules"] == 12
    assert body["warn_rules"] == 0
    assert body["failed_rules"] == 0
    assert body["total_quarantined_rows"] == 0
    assert body["sla_breach_count"] == 0
    assert body["sla_breaches"] == []
    assert len(body["table_summaries"]) == 3
    assert resp.headers.get("x-content-type-options") == "nosniff"


def test_quality_contracts_covers_all_five_dbt_assertion_rule_types(client: TestClient) -> None:
    resp = client.post("/api/v1/quality/evaluate-contracts", json={"dataset_scale": 100_000})
    assert resp.status_code == 200
    assertions = resp.json()["assertions"]
    rule_types = {a["rule_type"] for a in assertions}

    assert rule_types == {
        "not_null",
        "unique",
        "accepted_range",
        "referential_integrity",
        "freshness_sla_minutes",
    }
    tables = {a["table"] for a in assertions}
    assert tables == {"bronze_orders", "silver_vouchers", "gold_store_kpis"}


def test_quality_contracts_inject_null_store_id_fails_not_null_and_cascades_fk(
    client: TestClient,
) -> None:
    resp = client.post(
        "/api/v1/quality/evaluate-contracts",
        json={
            "dataset_scale": 100_000,
            "chaos_flags": {"null_store_id_pct": 1.8},
        },
    )
    assert resp.status_code == 200
    body = resp.json()

    assert body["data_trust_score"] < 90.0
    assert body["overall_status"] == "CRITICAL"
    assert body["failed_rules"] >= 2
    assert body["total_quarantined_rows"] >= 1800

    by_id = {a["rule_id"]: a for a in body["assertions"]}
    assert by_id["dq-bronze-orders-store-id-not-null"]["status"] == "CRITICAL_FAIL"
    assert by_id["dq-bronze-orders-store-id-not-null"]["quarantined_rows"] == 1800
    assert by_id["dq-gold-store-kpis-store-fk"]["status"] == "CRITICAL_FAIL"
    assert by_id["dq-gold-store-kpis-store-fk"]["failed_rows"] > 0


def test_quality_contracts_inject_duplicate_vouchers_triggers_unique_and_range_failures(
    client: TestClient,
) -> None:
    resp = client.post(
        "/api/v1/quality/evaluate-contracts",
        json={
            "dataset_scale": 100_000,
            "chaos_flags": {"duplicate_voucher_count": 412},
        },
    )
    assert resp.status_code == 200
    body = resp.json()

    assert body["data_trust_score"] < 85.0
    assert body["overall_status"] == "CRITICAL"
    by_id = {a["rule_id"]: a for a in body["assertions"]}
    assert by_id["dq-silver-vouchers-redemption-unique"]["status"] == "CRITICAL_FAIL"
    assert by_id["dq-silver-vouchers-redemption-unique"]["quarantined_rows"] == 412
    assert by_id["dq-silver-vouchers-discount-range"]["status"] == "CRITICAL_FAIL"
    assert body["total_quarantined_rows"] > 412


def test_quality_contracts_simulate_45m_kafka_cdc_lag_breaches_all_freshness_slas(
    client: TestClient,
) -> None:
    resp = client.post(
        "/api/v1/quality/evaluate-contracts",
        json={
            "dataset_scale": 100_000,
            "chaos_flags": {"kafka_cdc_lag_minutes": 45.0},
        },
    )
    assert resp.status_code == 200
    body = resp.json()

    assert body["sla_breach_count"] == 3
    assert body["overall_status"] == "CRITICAL"
    assert body["data_trust_score"] < 80.0
    breached_tables = {b["table"] for b in body["sla_breaches"]}
    assert breached_tables == {"bronze_orders", "silver_vouchers", "gold_store_kpis"}
    for breach in body["sla_breaches"]:
        assert breach["observed_lag_minutes"] >= 45.0
        assert breach["excess_minutes"] > 25.0


def test_quality_contracts_multi_chaos_stacking_accumulates_quarantine_and_drops_score(
    client: TestClient,
) -> None:
    single = client.post(
        "/api/v1/quality/evaluate-contracts",
        json={"chaos_flags": {"null_store_id_pct": 1.8}},
    ).json()
    stacked = client.post(
        "/api/v1/quality/evaluate-contracts",
        json={
            "chaos_flags": {
                "null_store_id_pct": 1.8,
                "duplicate_voucher_count": 412,
                "kafka_cdc_lag_minutes": 45.0,
            }
        },
    ).json()

    assert stacked["data_trust_score"] < single["data_trust_score"]
    assert stacked["data_trust_score"] < 55.0
    assert stacked["total_quarantined_rows"] > single["total_quarantined_rows"]
    assert stacked["failed_rules"] >= 6
    assert stacked["sla_breach_count"] == 3


def test_quality_contracts_mild_fault_emits_warn_and_degraded_status(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/quality/evaluate-contracts",
        json={
            "dataset_scale": 100_000,
            "chaos_flags": {"null_store_id_pct": 0.1},
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    by_id = {a["rule_id"]: a for a in body["assertions"]}
    assert by_id["dq-bronze-orders-store-id-not-null"]["status"] == "WARN"
    assert body["warn_rules"] >= 1
    assert body["failed_rules"] == 0
    assert body["overall_status"] == "DEGRADED"
    assert 85.0 <= body["data_trust_score"] < 100.0


def test_quality_contracts_out_of_range_and_orphan_fk_flags_quarantine_rows(
    client: TestClient,
) -> None:
    resp = client.post(
        "/api/v1/quality/evaluate-contracts",
        json={
            "chaos_flags": {
                "out_of_range_amount_count": 64,
                "orphan_fk_count": 29,
            }
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    by_id = {a["rule_id"]: a for a in body["assertions"]}
    assert by_id["dq-bronze-orders-amount-range"]["status"] == "CRITICAL_FAIL"
    assert by_id["dq-bronze-orders-amount-range"]["quarantined_rows"] == 64
    assert by_id["dq-silver-vouchers-order-fk"]["status"] == "CRITICAL_FAIL"
    assert by_id["dq-silver-vouchers-order-fk"]["quarantined_rows"] == 29
    assert body["total_quarantined_rows"] == 93


def test_quality_contracts_scales_quarantined_rows_proportionally_with_dataset_scale(
    client: TestClient,
) -> None:
    res_100k = client.post(
        "/api/v1/quality/evaluate-contracts",
        json={"dataset_scale": 100_000, "chaos_flags": {"null_store_id_pct": 1.8}},
    ).json()
    res_500k = client.post(
        "/api/v1/quality/evaluate-contracts",
        json={"dataset_scale": 500_000, "chaos_flags": {"null_store_id_pct": 1.8}},
    ).json()

    by_100k = {a["rule_id"]: a for a in res_100k["assertions"]}
    by_500k = {a["rule_id"]: a for a in res_500k["assertions"]}
    assert by_100k["dq-bronze-orders-store-id-not-null"]["quarantined_rows"] == 1800
    assert by_500k["dq-bronze-orders-store-id-not-null"]["quarantined_rows"] == 9000


def test_quality_contracts_tables_filter_scopes_evaluation_to_selected_table(
    client: TestClient,
) -> None:
    resp = client.post(
        "/api/v1/quality/evaluate-contracts",
        json={
            "tables_filter": ["silver_vouchers"],
            "chaos_flags": {"duplicate_voucher_count": 250},
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert all(a["table"] == "silver_vouchers" for a in body["assertions"])
    assert len(body["table_summaries"]) == 1
    assert body["table_summaries"][0]["table"] == "silver_vouchers"
    assert body["total_rules"] == 4


def test_quality_contracts_supports_custom_contract_rules(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/quality/evaluate-contracts",
        json={
            "custom_rules": [
                {
                    "rule_id": "custom-loyalty-points-range",
                    "table": "silver_vouchers",
                    "column": "loyalty_points",
                    "rule_type": "accepted_range",
                    "observed_value": 12.0,
                    "warn_threshold": 1.0,
                    "fail_threshold": 5.0,
                    "failed_rows": 12,
                    "min_value": 0.0,
                    "max_value": 50000.0,
                    "weight": 10.0,
                }
            ]
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_rules"] == 13
    by_id = {a["rule_id"]: a for a in body["assertions"]}
    assert "custom-loyalty-points-range" in by_id
    assert by_id["custom-loyalty-points-range"]["status"] == "CRITICAL_FAIL"
    assert body["total_quarantined_rows"] == 12


def test_quality_contracts_generates_valid_dbt_v2_schema_yaml(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/quality/evaluate-contracts",
        json={"chaos_flags": {"null_store_id_pct": 1.8}},
    )
    assert resp.status_code == 200
    yaml_text = resp.json()["dbt_schema_yaml"]

    assert "version: 2" in yaml_text
    assert "sources:" in yaml_text
    assert "models:" in yaml_text
    assert "bronze_orders" in yaml_text
    assert "silver_vouchers" in yaml_text
    assert "gold_store_kpis" in yaml_text
    assert "not_null" in yaml_text
    assert "unique" in yaml_text
    assert "relationships:" in yaml_text
    assert "dbt_utils.accepted_range:" in yaml_text
    assert "freshness:" in yaml_text


def test_quality_contracts_timeline_has_24_hourly_buckets_reflecting_live_chaos(
    client: TestClient,
) -> None:
    resp = client.post(
        "/api/v1/quality/evaluate-contracts",
        json={"chaos_flags": {"kafka_cdc_lag_minutes": 45.0, "null_store_id_pct": 1.8}},
    )
    assert resp.status_code == 200
    body = resp.json()
    timeline = body["timeline_24h"]

    assert len(timeline) == 24
    assert timeline[0]["hour_label"] == "00:00"
    assert timeline[-1]["hour_label"] == "NOW"
    assert timeline[-1]["trust_score"] == body["data_trust_score"]
    assert timeline[-1]["sla_breached"] is True
    assert timeline[-1]["freshness_lag_minutes"] >= 45.0
    assert all(0.0 <= pt["trust_score"] <= 100.0 for pt in timeline)


def test_quality_contracts_rejects_invalid_payload_bounds_with_422(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/quality/evaluate-contracts",
        json={"dataset_scale": 5, "chaos_flags": {"null_store_id_pct": 150.0}},
    )
    assert resp.status_code == 422
