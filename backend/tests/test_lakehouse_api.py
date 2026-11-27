"""Integration & Unit Tests for Nexus Lake v4.0 FastAPI Analytical Lakehouse Backend."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Ensure `backend/` is importable regardless of working directory when invoking pytest
BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from nexus_api.lakehouse import (  # noqa: E402
    LineageEdgeSpec,
    compute_topological_order,
)
from nexus_api.main import create_app  # noqa: E402


@pytest.fixture()
def client() -> TestClient:
    app = create_app(db_path=":memory:")
    return TestClient(app)


def test_health_endpoint_returns_service_metadata(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "nexus-lake-api"
    assert body["version"] == "4.0.0"
    assert body["tables_loaded"] == 6
    assert body["uptime_ms"] >= 0
    assert resp.headers.get("x-content-type-options") == "nosniff"
    assert resp.headers.get("referrer-policy") == "strict-origin-when-cross-origin"


def test_catalog_lineage_returns_medallion_layers_and_live_counts(client: TestClient) -> None:
    resp = client.get("/api/v1/catalog/lineage")
    assert resp.status_code == 200
    data = resp.json()

    assert data["layers"] == ["bronze", "silver", "gold"]
    assert data["is_acyclic"] is True
    assert len(data["tables"]) == 6
    assert len(data["edges"]) == 5

    by_id = {t["id"]: t for t in data["tables"]}
    assert by_id["bronze_pos_events"]["row_count"] == 600
    assert by_id["silver_transactions_clean"]["row_count"] == 600
    assert by_id["gold_regional_revenue_mart"]["row_count"] > 0
    assert by_id["gold_nrr_cohort_mart"]["row_count"] == 18
    assert by_id["bronze_pos_events"]["null_rate_pct"] > 0
    assert by_id["gold_regional_revenue_mart"]["quality_grade"] == "A"


def test_catalog_lineage_topological_order_is_strictly_forward(client: TestClient) -> None:
    data = client.get("/api/v1/catalog/lineage").json()
    topo = data["topological_order"]
    assert len(topo) == len(data["tables"])
    pos = {tid: idx for idx, tid in enumerate(topo)}

    for edge in data["edges"]:
        assert pos[edge["source"]] < pos[edge["target"]]


def test_topological_cycle_detector_catches_invalid_feedback_loop() -> None:
    acyclic, order = compute_topological_order(
        ["a", "b", "c"],
        [
            LineageEdgeSpec("e1", "a", "b", "t1", "transform"),
            LineageEdgeSpec("e2", "b", "c", "t2", "materialize"),
            LineageEdgeSpec("e3", "c", "a", "loop", "transform"),
        ],
    )
    assert acyclic is False
    assert order == []


def test_sql_execute_select_with_where_and_order_by(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/sql/execute",
        json={
            "sql": (
                "SELECT tx_id, region, amount_usd, risk_score "
                "FROM bronze_pos_events "
                "WHERE region = 'APAC-VN' AND is_anomaly = 1 "
                "ORDER BY amount_usd DESC LIMIT 10"
            )
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["columns"] == ["tx_id", "region", "amount_usd", "risk_score"]
    assert 0 < body["row_count"] <= 10
    assert all(r["region"] == "APAC-VN" for r in body["rows"])
    assert body["execution_ms"] >= 0
    assert len(body["query_plan"]) >= 1
    assert body["cost_estimate"]["partition_pruning_ratio"] > 0


def test_sql_execute_group_by_aggregation_with_explain_plan(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/sql/execute",
        json={
            "sql": (
                "SELECT region, COUNT(*) AS tx_count, "
                "ROUND(SUM(amount_usd), 2) AS gross_volume_usd, "
                "SUM(is_anomaly) AS anomaly_count "
                "FROM silver_transactions_clean "
                "GROUP BY region "
                "ORDER BY gross_volume_usd DESC;"
            )
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["row_count"] == 5
    assert sum(r["tx_count"] for r in body["rows"]) == 600
    assert body["rows"][0]["gross_volume_usd"] >= body["rows"][-1]["gross_volume_usd"]
    assert any("silver_transactions_clean" in step["detail"] for step in body["query_plan"])


def test_sql_execute_cte_with_clause_across_gold_marts(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/sql/execute",
        json={
            "sql": (
                "WITH regional_totals AS ("
                "  SELECT region, SUM(gross_volume_usd) AS total_gmv, SUM(tx_count) AS total_tx "
                "  FROM gold_regional_revenue_mart GROUP BY region"
                ") "
                "SELECT region, ROUND(total_gmv, 2) AS total_gmv, total_tx "
                "FROM regional_totals ORDER BY total_gmv DESC"
            )
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["row_count"] == 5
    assert sum(r["total_tx"] for r in body["rows"]) == 600


def test_sql_execute_enforces_max_rows_limit_cap(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/sql/execute",
        json={
            "sql": "SELECT tx_id, region, amount_usd FROM bronze_pos_events",
            "max_rows": 15,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["row_count"] == 15
    assert body["limit_applied"] == 15
    assert body["truncated"] is True


def test_sql_execute_allows_forbidden_words_inside_string_literals(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/sql/execute",
        json={
            "sql": "SELECT tx_id FROM bronze_pos_events WHERE category != 'DROP DELETE UPDATE' LIMIT 5"
        },
    )
    assert resp.status_code == 200
    assert resp.json()["row_count"] == 5


@pytest.mark.parametrize(
    "malicious_sql",
    [
        "DROP TABLE bronze_pos_events",
        "DELETE FROM bronze_pos_events WHERE region = 'APAC-VN'",
        "UPDATE silver_transactions_clean SET amount_usd = 0",
        "INSERT INTO gold_regional_revenue_mart VALUES ('X','Y',1,1,1,0,1)",
        "ALTER TABLE bronze_pos_events ADD COLUMN hacked TEXT",
        "ATTACH DATABASE ':memory:' AS injected",
        "PRAGMA table_info(bronze_pos_events)",
        "SELECT * FROM bronze_pos_events LIMIT 1; DROP TABLE bronze_pos_events;",
        "SELECT /* harmless */ 1; --\nDELETE FROM silver_transactions_clean",
        "CREATE TABLE pwned (id INT)",
    ],
)
def test_sql_guardrail_blocks_ddl_dml_pragma_attach_and_stacked_injection(
    client: TestClient, malicious_sql: str
) -> None:
    resp = client.post("/api/v1/sql/execute", json={"sql": malicious_sql})
    assert resp.status_code == 403
    assert "detail" in resp.json()


def test_sql_execute_returns_400_on_syntax_or_missing_table_error(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/sql/execute",
        json={"sql": "SELECT non_existent_col FROM ghost_table"},
    )
    assert resp.status_code == 400


def test_sql_execute_returns_400_on_whitespace_only_sql(client: TestClient) -> None:
    resp = client.post("/api/v1/sql/execute", json={"sql": "   -- only comment   "})
    assert resp.status_code == 400


def test_profile_csv_infers_types_null_rates_min_max_and_distinct(client: TestClient) -> None:
    csv_text = (
        "order_id,order_date,units,revenue_usd,is_vip,city\n"
        "101,2026-11-01,4,120.50,true,HCMC\n"
        "102,2026-11-02,2,55.25,false,Hanoi\n"
        "103,2026-11-03,6,240.00,true,Danang\n"
        "104,2026-11-04,,90.00,false,HCMC\n"
    )
    resp = client.post(
        "/api/v1/ingest/profile-csv",
        json={"table_name": "Retail Orders Q4", "csv_content": csv_text},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["table_name"] == "retail_orders_q4"
    assert body["row_count"] == 4
    assert body["column_count"] == 6
    assert body["quality_score"] > 0

    cols = {c["name"]: c for c in body["columns"]}
    assert cols["order_id"]["inferred_type"] == "integer"
    assert cols["order_id"]["min"] == 101
    assert cols["order_id"]["max"] == 104
    assert cols["order_date"]["inferred_type"] == "date"
    assert cols["units"]["inferred_type"] == "integer"
    assert cols["units"]["null_count"] == 1
    assert cols["units"]["null_rate_pct"] == 25.0
    assert cols["revenue_usd"]["inferred_type"] == "float"
    assert cols["revenue_usd"]["min"] == 55.25
    assert cols["revenue_usd"]["max"] == 240.0
    assert cols["is_vip"]["inferred_type"] == "boolean"
    assert cols["city"]["inferred_type"] == "string"
    assert cols["city"]["distinct_count"] == 3


def test_profile_csv_strips_bom_and_flags_null_constant_duplicate_and_outlier_anomalies(
    client: TestClient,
) -> None:
    csv_text = (
        "\ufeffid,region,amount,notes\n"
        "1,VN,100.0,\n"
        "2,VN,102.0,\n"
        "3,VN,99.0,\n"
        "4,VN,101.0,\n"
        "5,VN,98.0,\n"
        "6,VN,100.5,\n"
        "7,VN,101.5,\n"
        "8,VN,100.0,\n"
        "9,VN,9999.0,vip_spike\n"
        "1,VN,100.0,\n"
    )
    resp = client.post(
        "/api/v1/ingest/profile-csv",
        json={"table_name": "anomaly_sample", "csv_content": csv_text},
    )
    assert resp.status_code == 200
    body = resp.json()
    codes = {a["code"] for a in body["anomalies"]}

    assert "HIGH_NULL_RATE" in codes
    assert "CONSTANT_COLUMN" in codes
    assert "DUPLICATE_ROWS" in codes
    assert "NUMERIC_OUTLIERS" in codes


def test_profile_csv_rejects_header_only_or_empty_payload(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/ingest/profile-csv",
        json={"table_name": "bad", "csv_content": "col_a,col_b\n"},
    )
    assert resp.status_code == 400


def test_catalog_refresh_rebuilds_silver_and_gold_marts(client: TestClient) -> None:
    resp = client.post("/api/v1/catalog/refresh")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "COMPLETED"
    assert body["refreshed_tables"]["silver_transactions_clean"] == 600
    assert body["refreshed_tables"]["gold_regional_revenue_mart"] > 0
    assert body["refreshed_tables"]["gold_nrr_cohort_mart"] == 18
    assert body["duration_ms"] >= 0
