/**
 * Real WebGPU WGSL Compute + Render Shaders for Nexus Lake 100K+ Point Anomaly Canvas.
 * Exposed cleanly in the live WGSL Shader Inspector drawer.
 */

export const ANOMALY_COMPUTE_WGSL = /* wgsl */ `
struct FilterUniforms {
  riskThreshold : f32,
  regionMask    : u32,
  minTimeNorm   : f32,
  yAxisMode     : u32, // 0 = risk_score, 1 = latency_ms
  pointCount    : u32,
  pointSizePx   : f32,
  viewportW     : f32,
  viewportH     : f32,
};

struct RawPoint {
  xNorm      : f32,
  riskScore  : f32,
  latNorm    : f32,
  regionIdx  : f32,
  timeNorm   : f32,
  isAnomaly  : f32,
};

struct FilteredPoint {
  clipX      : f32,
  clipY      : f32,
  risk       : f32,
  visible    : f32,
};

struct TelemetryCounters {
  visibleCount : atomic<u32>,
  anomalyCount : atomic<u32>,
};

@group(0) @binding(0) var<uniform> u : FilterUniforms;
@group(0) @binding(1) var<storage, read> inputPoints : array<RawPoint>;
@group(0) @binding(2) var<storage, read_write> outputPoints : array<FilteredPoint>;
@group(0) @binding(3) var<storage, read_write> counters : TelemetryCounters;

@compute @workgroup_size(256)
fn cs_filter_anomalies(@builtin(global_invocation_id) gid : vec3<u32>) {
  let idx = gid.x;
  if (idx >= u.pointCount) {
    return;
  }

  let pt = inputPoints[idx];
  let rBit = 1u << u32(pt.regionIdx);
  let regionPass = (u.regionMask & rBit) != 0u;
  let timePass = pt.timeNorm >= u.minTimeNorm;
  let riskPass = pt.riskScore >= u.riskThreshold;

  if (regionPass && timePass && riskPass) {
    let yVal = select(pt.riskScore, pt.latNorm, u.yAxisMode == 1u);
    let cx = pt.xNorm * 1.88 - 0.94;
    let cy = yVal * 1.84 - 0.92;

    outputPoints[idx] = FilteredPoint(cx, cy, pt.riskScore, 1.0);
    atomicAdd(&counters.visibleCount, 1u);
    if (pt.isAnomaly > 0.5) {
      atomicAdd(&counters.anomalyCount, 1u);
    }
  } else {
    outputPoints[idx] = FilteredPoint(2.5, 2.5, 0.0, 0.0);
  }
}
`.trim();

export const ANOMALY_RENDER_WGSL = /* wgsl */ `
struct FilterUniforms {
  riskThreshold : f32,
  regionMask    : u32,
  minTimeNorm   : f32,
  yAxisMode     : u32,
  pointCount    : u32,
  pointSizePx   : f32,
  viewportW     : f32,
  viewportH     : f32,
};

struct FilteredPoint {
  clipX      : f32,
  clipY      : f32,
  risk       : f32,
  visible    : f32,
};

struct VertexOut {
  @builtin(position) position : vec4<f32>,
  @location(0) localUv        : vec2<f32>,
  @location(1) risk           : f32,
  @location(2) visible        : f32,
};

@group(0) @binding(0) var<uniform> u : FilterUniforms;
@group(0) @binding(1) var<storage, read> points : array<FilteredPoint>;

const QUAD_CORNERS = array<vec2<f32>, 6>(
  vec2<f32>(-1.0, -1.0),
  vec2<f32>( 1.0, -1.0),
  vec2<f32>(-1.0,  1.0),
  vec2<f32>(-1.0,  1.0),
  vec2<f32>( 1.0, -1.0),
  vec2<f32>( 1.0,  1.0)
);

@vertex
fn vs_main(
  @builtin(vertex_index) vIdx : u32,
  @builtin(instance_index) iIdx : u32
) -> VertexOut {
  let pt = points[iIdx];
  let corner = QUAD_CORNERS[vIdx];
  let isHighRisk = pt.risk >= 0.75;
  let pxScale = select(u.pointSizePx, u.pointSizePx * 1.55, isHighRisk);

  let offsetX = (corner.x * pxScale) / max(1.0, u.viewportW);
  let offsetY = (corner.y * pxScale) / max(1.0, u.viewportH);

  var out : VertexOut;
  out.position = vec4<f32>(pt.clipX + offsetX, pt.clipY + offsetY, 0.0, 1.0);
  out.localUv = corner;
  out.risk = pt.risk;
  out.visible = pt.visible;
  return out;
}

@fragment
fn fs_main(in : VertexOut) -> @location(0) vec4<f32> {
  if (in.visible < 0.5) {
    discard;
  }
  let dist = length(in.localUv);
  if (dist > 1.0) {
    discard;
  }

  let softEdge = 1.0 - smoothstep(0.62, 1.0, dist);
  let isAnomaly = in.risk >= 0.75;

  // Nominal: Electric Cyan (#06B6D4) | Anomaly Burst: Signal Vermilion (#FF5500)
  let cyanColor = vec3<f32>(0.024, 0.714, 0.831);
  let amberColor = vec3<f32>(0.961, 0.620, 0.043);
  let signalColor = vec3<f32>(1.0, 0.333, 0.0);

  var color = cyanColor;
  var alpha = 0.42 * softEdge;

  if (isAnomaly) {
    color = signalColor;
    alpha = 0.92 * softEdge;
  } else if (in.risk >= 0.50) {
    color = mix(cyanColor, amberColor, (in.risk - 0.50) * 4.0);
    alpha = 0.65 * softEdge;
  }

  return vec4<f32>(color, alpha);
}
`.trim();
