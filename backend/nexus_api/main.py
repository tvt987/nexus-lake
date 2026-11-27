"""FastAPI Application exposing Nexus Lake v4.0 Analytical Lakehouse Endpoints."""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import __version__
from .lakehouse import (
    CsvProfilingError,
    NexusLakehouseEngine,
    SqlExecutionError,
    SqlGuardViolationError,
    profile_csv_content,
)


class SqlExecuteRequest(BaseModel):
    sql: str = Field(
        ...,
        min_length=1,
        max_length=16_000,
        description="Read-only SELECT or WITH SQL statement to execute against seeded Medallion tables.",
        examples=[
            "SELECT region, COUNT(*) AS tx_count, ROUND(SUM(amount_usd), 2) AS gmv_usd FROM bronze_pos_events GROUP BY region ORDER BY gmv_usd DESC"
        ],
    )
    max_rows: int = Field(
        default=500,
        ge=1,
        le=1000,
        description="Hard upper bound on returned rows (capped at 1000).",
    )


class QueryPlanStepModel(BaseModel):
    id: int
    parent: int
    detail: str


class QueryCostEstimateModel(BaseModel):
    estimated_scan_rows: int
    partition_pruning_ratio: float
    memory_footprint_mb: float


class SqlExecuteResponse(BaseModel):
    columns: list[str]
    rows: list[dict[str, Any]]
    row_count: int
    truncated: bool
    limit_applied: int
    execution_ms: float
    query_plan: list[QueryPlanStepModel]
    cost_estimate: QueryCostEstimateModel


class CsvProfileRequest(BaseModel):
    table_name: str = Field(
        default="uploaded_dataset",
        min_length=1,
        max_length=120,
        description="Logical destination table identifier.",
    )
    csv_content: str = Field(
        ...,
        min_length=1,
        max_length=5_000_000,
        description="Raw CSV payload (UTF-8 or UTF-8 BOM).",
    )


class ColumnProfileModel(BaseModel):
    name: str
    inferred_type: str
    null_count: int
    null_rate_pct: float
    distinct_count: int
    min: Any = None
    max: Any = None
    mean: float | None = None
    sample_values: list[str]


class ProfileAnomalyModel(BaseModel):
    column: str
    code: str
    severity: str
    message: str


class CsvProfileResponse(BaseModel):
    table_name: str
    row_count: int
    column_count: int
    delimiter: str
    quality_score: float
    parse_ms: float
    columns: list[ColumnProfileModel]
    anomalies: list[ProfileAnomalyModel]


class LineageColumnModel(BaseModel):
    name: str
    type: str
    is_pk: bool
    null_rate_pct: float


class LineageTableModel(BaseModel):
    id: str
    name: str
    layer: str
    kind: str
    description: str
    row_count: int
    null_rate_pct: float
    quality_grade: str
    partition_key: str
    refresh_sla_sec: int
    columns: list[LineageColumnModel]


class LineageEdgeModel(BaseModel):
    id: str
    source: str
    target: str
    transform: str
    edge_type: str


class LineageCatalogResponse(BaseModel):
    layers: list[str]
    tables: list[LineageTableModel]
    edges: list[LineageEdgeModel]
    topological_order: list[str]
    is_acyclic: bool


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
    engine: str
    tables_loaded: int
    uptime_ms: float


class CatalogRefreshResponse(BaseModel):
    status: str
    refreshed_tables: dict[str, int]
    duration_ms: float
    refreshed_at: str


def create_app(db_path: str | None = None) -> FastAPI:
    resolved_db = db_path or os.getenv("NEXUS_DB_PATH", ":memory:")
    engine = NexusLakehouseEngine(db_path=resolved_db)

    app = FastAPI(
        title="Nexus Lake v4.0 Analytical Lakehouse API",
        version=__version__,
        description=(
            "Read-only guarded SQLite Medallion Lakehouse execution engine, "
            "Bronze/Silver/Gold Lineage DAG catalog, and CSV statistical schema profiler."
        ),
    )

    raw_origins = os.getenv(
        "NEXUS_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173,http://localhost:8080",
    )
    allowed_origins = [o.strip() for o in raw_origins.split(",") if o.strip()]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization"],
    )

    @app.middleware("http")
    async def apply_security_headers(request: Request, call_next: Any) -> Response:
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response

    app.state.engine = engine

    @app.get("/health", response_model=HealthResponse, tags=["System"])
    def get_health() -> dict[str, Any]:
        lineage = engine.get_medallion_lineage()
        return {
            "status": "ok",
            "service": "nexus-lake-api",
            "version": __version__,
            "engine": "sqlite3-readonly-lakehouse",
            "tables_loaded": len(lineage["tables"]),
            "uptime_ms": engine.uptime_ms,
        }

    @app.get(
        "/api/v1/catalog/lineage",
        response_model=LineageCatalogResponse,
        tags=["Catalog"],
    )
    def get_catalog_lineage() -> dict[str, Any]:
        return engine.get_medallion_lineage()

    @app.post(
        "/api/v1/catalog/refresh",
        response_model=CatalogRefreshResponse,
        tags=["Catalog"],
    )
    def post_catalog_refresh() -> dict[str, Any]:
        return engine.refresh_materialized_marts()

    @app.post(
        "/api/v1/sql/execute",
        response_model=SqlExecuteResponse,
        tags=["SQL Engine"],
    )
    def post_sql_execute(payload: SqlExecuteRequest) -> dict[str, Any]:
        try:
            return engine.execute_readonly_sql(payload.sql, max_rows=payload.max_rows)
        except SqlGuardViolationError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except SqlExecutionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post(
        "/api/v1/ingest/profile-csv",
        response_model=CsvProfileResponse,
        tags=["Ingestion"],
    )
    def post_profile_csv(payload: CsvProfileRequest) -> dict[str, Any]:
        try:
            return profile_csv_content(payload.csv_content, table_name=payload.table_name)
        except CsvProfilingError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return app


app = create_app()
