import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Code2,
  Cpu,
  Crosshair,
  Play,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type { CopyDict } from '../i18n';
import {
  buildBrushSql,
  evaluateBrushedCluster,
  scatterToCanvasUv,
  screenRectToBrushBounds,
} from '../engine/brushToSql';
import { REGIONS } from '../engine/dataGenerator';
import { ANOMALY_COMPUTE_WGSL, ANOMALY_RENDER_WGSL } from '../engine/wgslShaders';
import type {
  BrushSelectionBounds,
  ColumnarTransactions,
  GpuFilterState,
  GpuTelemetry,
  RendererBackend,
  ThemeMode,
} from '../types/lakehouse';

interface WebGpuAnomalyCanvasProps {
  copy: CopyDict;
  dataset: ColumnarTransactions;
  theme: ThemeMode;
  onApplyBrushSql?: (sql: string, bounds: BrushSelectionBounds) => void;
  onBrushChange?: (bounds: BrushSelectionBounds | null) => void;
}

interface WebGpuPipelineState {
  // Typed via minimal WebGPU structural interface so tsc compiles without @webgpu/types
  device: any;
  context: any;
  format: string;
  computePipeline: any;
  renderPipeline: any;
  uniformBuffer: any;
  inputBuffer: any;
  outputBuffer: any;
  counterBuffer: any;
  computeBindGroup: any;
  renderBindGroup: any;
  pointCount: number;
  capacityPoints: number;
}

interface DragRectState {
  startU: number;
  startV: number;
  curU: number;
  curV: number;
  dragging: boolean;
}

const WEBGL2_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_posRiskLat; // x, risk, latNorm, regionIdx
layout(location = 1) in vec2 a_timeAnom;   // timeNorm, isAnomaly

uniform float u_riskThreshold;
uniform float u_regionMask;
uniform float u_minTimeNorm;
uniform float u_yAxisMode;
uniform float u_pointSize;

out float v_risk;
out float v_visible;

void main() {
  int rBit = 1 << int(a_posRiskLat.w + 0.5);
  int maskInt = int(u_regionMask + 0.5);
  bool regionOk = (maskInt & rBit) != 0;
  bool timeOk = a_timeAnom.x >= u_minTimeNorm;
  bool riskOk = a_posRiskLat.y >= u_riskThreshold;

  if (regionOk && timeOk && riskOk) {
    float yVal = u_yAxisMode > 0.5 ? a_posRiskLat.z : a_posRiskLat.y;
    float cx = a_posRiskLat.x * 1.88 - 0.94;
    float cy = yVal * 1.84 - 0.92;
    gl_Position = vec4(cx, cy, 0.0, 1.0);
    gl_PointSize = a_posRiskLat.y >= 0.75 ? u_pointSize * 1.6 : u_pointSize;
    v_risk = a_posRiskLat.y;
    v_visible = 1.0;
  } else {
    gl_Position = vec4(2.5, 2.5, 0.0, 1.0);
    gl_PointSize = 0.0;
    v_risk = 0.0;
    v_visible = 0.0;
  }
}`;

const WEBGL2_FS = `#version 300 es
precision highp float;
in float v_risk;
in float v_visible;
out vec4 fragColor;

void main() {
  if (v_visible < 0.5) discard;
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float dist = length(c);
  if (dist > 1.0) discard;
  float alpha = 1.0 - smoothstep(0.6, 1.0, dist);

  vec3 cyan = vec3(0.024, 0.714, 0.831);
  vec3 amber = vec3(0.961, 0.620, 0.043);
  vec3 signal = vec3(1.0, 0.333, 0.0);

  if (v_risk >= 0.75) {
    fragColor = vec4(signal, 0.92 * alpha);
  } else if (v_risk >= 0.50) {
    vec3 col = mix(cyan, amber, (v_risk - 0.50) * 4.0);
    fragColor = vec4(col, 0.64 * alpha);
  } else {
    fragColor = vec4(cyan, 0.42 * alpha);
  }
}`;

export const WebGpuAnomalyCanvas: React.FC<WebGpuAnomalyCanvasProps> = ({
  copy,
  dataset,
  theme,
  onApplyBrushSql,
  onBrushChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const plotWrapRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<GpuFilterState>({
    riskThreshold: 0.0,
    regionMask: 0b11111,
    timeWindowPct: 100,
    yAxisMode: 'risk_score',
    pointSize: 3.0,
  });
  const [telemetry, setTelemetry] = useState<GpuTelemetry>({
    renderer: 'CANVAS2D FALLBACK',
    fps: 60,
    totalPoints: dataset.rowCount,
    visiblePoints: dataset.rowCount,
    anomalyPoints: 0,
    frameTimeMs: 1.4,
    shaderCompileMs: 0,
  });
  const [showInspector, setShowInspector] = useState(false);
  const [shaderTab, setShaderTab] = useState<'compute' | 'render'>('compute');
  const [computeSource, setComputeSource] = useState(ANOMALY_COMPUTE_WGSL);
  const [renderSource, setRenderSource] = useState(ANOMALY_RENDER_WGSL);
  const [shaderStatus, setShaderStatus] = useState('WGSL Verified');

  // v2.0 Interactive Brush-to-SQL Lasso state
  const [dragRect, setDragRect] = useState<DragRectState | null>(null);
  const [lockedUvRect, setLockedUvRect] = useState<{
    u1: number;
    v1: number;
    u2: number;
    v2: number;
  } | null>(null);

  const filterRef = useRef(filter);
  filterRef.current = filter;

  const themeRef = useRef(theme);
  themeRef.current = theme;

  const datasetRef = useRef(dataset);
  const datasetVersionRef = useRef(0);
  if (datasetRef.current !== dataset) {
    datasetRef.current = dataset;
    datasetVersionRef.current += 1;
  }

  const [compileNonce, setCompileNonce] = useState(0);

  // Active UV rect (either while dragging or locked)
  const activeUvRect = useMemo(() => {
    if (dragRect) {
      const du = Math.abs(dragRect.curU - dragRect.startU);
      const dv = Math.abs(dragRect.curV - dragRect.startV);
      if (du > 0.012 && dv > 0.012) {
        return {
          u1: dragRect.startU,
          v1: dragRect.startV,
          u2: dragRect.curU,
          v2: dragRect.curV,
        };
      }
    }
    return lockedUvRect;
  }, [dragRect, lockedUvRect]);

  const brushMetrics = useMemo(() => {
    if (!activeUvRect) return null;
    const bounds = screenRectToBrushBounds(
      activeUvRect.u1,
      activeUvRect.v1,
      activeUvRect.u2,
      activeUvRect.v2,
      filter,
    );
    return evaluateBrushedCluster(dataset, bounds, filter);
  }, [activeUvRect, dataset, filter]);

  useEffect(() => {
    onBrushChange?.(brushMetrics?.bounds ?? null);
  }, [brushMetrics, onBrushChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let rafId = 0;
    let rendererMode: RendererBackend = 'CANVAS2D FALLBACK';
    let webgpuState: WebGpuPipelineState | null = null;
    let gl: WebGL2RenderingContext | null = null;
    let glProgram: WebGLProgram | null = null;
    let glVao: WebGLVertexArrayObject | null = null;
    let glBuffer: WebGLBuffer | null = null;
    let ctx2d: CanvasRenderingContext2D | null = null;

    const uniformView = new ArrayBuffer(32);
    const uniformF32 = new Float32Array(uniformView);
    const uniformU32 = new Uint32Array(uniformView);

    const computeVisibleCounts = (
      ds: ColumnarTransactions,
      f: GpuFilterState,
    ): { visible: number; anomalies: number } => {
      const buf = ds.gpuVertexBuffer;
      const n = ds.rowCount;
      const minTime = 1 - f.timeWindowPct / 100;
      let vis = 0;
      let anom = 0;
      for (let i = 0; i < n; i += 1) {
        const b = i * 6;
        const risk = buf[b + 1];
        const rBit = 1 << (buf[b + 3] | 0);
        const tNorm = buf[b + 4];
        if (risk >= f.riskThreshold && (f.regionMask & rBit) !== 0 && tNorm >= minTime) {
          vis += 1;
          if (buf[b + 5] > 0.5) anom += 1;
        }
      }
      return { visible: vis, anomalies: anom };
    };

    const syncCanvasSize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const targetW = Math.max(320, Math.floor(rect.width * dpr));
      const targetH = Math.max(220, Math.floor(rect.height * dpr));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      return dpr;
    };

    const rebuildWebGpuBuffers = (state: WebGpuPipelineState, ds: ColumnarTransactions) => {
      const GPUBufferUsage = (globalThis as unknown as { GPUBufferUsage: any }).GPUBufferUsage;
      if (ds.rowCount > state.capacityPoints) {
        try {
          state.inputBuffer.destroy();
          state.outputBuffer.destroy();
        } catch {
          // ignore
        }
        const nextCap = Math.max(ds.rowCount, Math.ceil(ds.rowCount * 1.25));
        state.inputBuffer = state.device.createBuffer({
          size: nextCap * 6 * 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        state.outputBuffer = state.device.createBuffer({
          size: nextCap * 16,
          usage: GPUBufferUsage.STORAGE,
        });
        state.computeBindGroup = state.device.createBindGroup({
          layout: state.computePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: state.uniformBuffer } },
            { binding: 1, resource: { buffer: state.inputBuffer } },
            { binding: 2, resource: { buffer: state.outputBuffer } },
            { binding: 3, resource: { buffer: state.counterBuffer } },
          ],
        });
        state.renderBindGroup = state.device.createBindGroup({
          layout: state.renderPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: state.uniformBuffer } },
            { binding: 1, resource: { buffer: state.outputBuffer } },
          ],
        });
        state.capacityPoints = nextCap;
      }
      state.device.queue.writeBuffer(state.inputBuffer, 0, ds.gpuVertexBuffer);
      state.pointCount = ds.rowCount;
    };

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            syncCanvasSize();
          })
        : null;
    resizeObserver?.observe(canvas);

    const initPipeline = async () => {
      const compileStart = performance.now();
      const dpr = syncCanvasSize();
      const initialDs = datasetRef.current;

      // Attempt 1: Real WebGPU (WGSL Compute + Render Pipeline)
      const navGpu = (navigator as unknown as { gpu?: any }).gpu;
      if (navGpu) {
        try {
          const adapter = await navGpu.requestAdapter({ powerPreference: 'high-performance' });
          if (adapter) {
            const device = await adapter.requestDevice();
            const context = canvas.getContext('webgpu') as any;
            if (context) {
              const format = navGpu.getPreferredCanvasFormat();
              context.configure({
                device,
                format,
                alphaMode: 'premultiplied',
              });

              const computeModule = device.createShaderModule({ code: computeSource });
              const renderModule = device.createShaderModule({ code: renderSource });

              const computePipeline = device.createComputePipeline({
                layout: 'auto',
                compute: { module: computeModule, entryPoint: 'cs_filter_anomalies' },
              });

              const renderPipeline = device.createRenderPipeline({
                layout: 'auto',
                vertex: { module: renderModule, entryPoint: 'vs_main' },
                fragment: {
                  module: renderModule,
                  entryPoint: 'fs_main',
                  targets: [
                    {
                      format,
                      blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                      },
                    },
                  ],
                },
                primitive: { topology: 'triangle-list' },
              });

              const GPUBufferUsage = (globalThis as unknown as { GPUBufferUsage: any }).GPUBufferUsage;
              const uniformBuffer = device.createBuffer({
                size: 32,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
              });

              const capacityPoints = Math.max(initialDs.rowCount, 150_000);
              const inputBuffer = device.createBuffer({
                size: capacityPoints * 6 * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
              });
              device.queue.writeBuffer(inputBuffer, 0, initialDs.gpuVertexBuffer);

              const outputBuffer = device.createBuffer({
                size: capacityPoints * 16,
                usage: GPUBufferUsage.STORAGE,
              });

              const counterBuffer = device.createBuffer({
                size: 8,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
              });

              const computeBindGroup = device.createBindGroup({
                layout: computePipeline.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: { buffer: uniformBuffer } },
                  { binding: 1, resource: { buffer: inputBuffer } },
                  { binding: 2, resource: { buffer: outputBuffer } },
                  { binding: 3, resource: { buffer: counterBuffer } },
                ],
              });

              const renderBindGroup = device.createBindGroup({
                layout: renderPipeline.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: { buffer: uniformBuffer } },
                  { binding: 1, resource: { buffer: outputBuffer } },
                ],
              });

              webgpuState = {
                device,
                context,
                format,
                computePipeline,
                renderPipeline,
                uniformBuffer,
                inputBuffer,
                outputBuffer,
                counterBuffer,
                computeBindGroup,
                renderBindGroup,
                pointCount: initialDs.rowCount,
                capacityPoints,
              };
              rendererMode = 'WEBGPU WGSL';
              setShaderStatus('WebGPU Compute + Render Compiled');
            }
          }
        } catch (err) {
          console.warn('[NexusLake] WebGPU init fell back cleanly:', err);
          setShaderStatus('WebGPU unavailable — running hardware fallback');
        }
      }

      // Attempt 2: Hardware-Accelerated WebGL2 Fallback
      if (!webgpuState) {
        try {
          gl = canvas.getContext('webgl2', {
            antialias: false,
            alpha: true,
            preserveDrawingBuffer: true,
          });
          if (gl) {
            const compileShader = (type: number, src: string) => {
              const s = gl!.createShader(type)!;
              gl!.shaderSource(s, src);
              gl!.compileShader(s);
              if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) {
                throw new Error(gl!.getShaderInfoLog(s) || 'WebGL2 shader error');
              }
              return s;
            };
            const vs = compileShader(gl.VERTEX_SHADER, WEBGL2_VS);
            const fs = compileShader(gl.FRAGMENT_SHADER, WEBGL2_FS);
            glProgram = gl.createProgram()!;
            gl.attachShader(glProgram, vs);
            gl.attachShader(glProgram, fs);
            gl.linkProgram(glProgram);

            glVao = gl.createVertexArray();
            gl.bindVertexArray(glVao);
            glBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, initialDs.gpuVertexBuffer, gl.DYNAMIC_DRAW);

            const stride = 6 * 4;
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 4 * 4);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

            rendererMode = 'WEBGL2 FALLBACK';
          }
        } catch {
          gl = null;
        }
      }

      // Attempt 3: Crisp Hi-DPI Canvas2D Fast Path
      if (!webgpuState && !gl) {
        ctx2d = canvas.getContext('2d');
        rendererMode = 'CANVAS2D FALLBACK';
      }

      const compileMs = Number((performance.now() - compileStart).toFixed(1));
      let lastFpsStamp = performance.now();
      let frameCounter = 0;
      let currentFps = 60;
      let lastFilterHash = '';
      let lastRenderHash = '';
      let uploadedVersion = datasetVersionRef.current;
      let cachedCounts = computeVisibleCounts(initialDs, filterRef.current);

      const renderFrame = () => {
        if (disposed) return;
        const f = filterRef.current;
        const ds = datasetRef.current;
        const isDark = themeRef.current === 'dark';

        const renderHash = `${datasetVersionRef.current}|${f.riskThreshold}|${f.regionMask}|${f.timeWindowPct}|${f.yAxisMode}|${f.pointSize}|${isDark}|${canvas.width}x${canvas.height}`;
        if (renderHash === lastRenderHash) {
          rafId = requestAnimationFrame(renderFrame);
          return;
        }
        lastRenderHash = renderHash;

        const frameStart = performance.now();

        // Zero-teardown hot GPU buffer swap when CDC streams or dataset scales
        if (datasetVersionRef.current !== uploadedVersion) {
          uploadedVersion = datasetVersionRef.current;
          if (webgpuState) {
            rebuildWebGpuBuffers(webgpuState, ds);
          } else if (gl && glBuffer) {
            gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, ds.gpuVertexBuffer, gl.DYNAMIC_DRAW);
          }
          lastFilterHash = '';
        }

        const filterHash = `${uploadedVersion}|${f.riskThreshold}|${f.regionMask}|${f.timeWindowPct}|${f.yAxisMode}`;
        if (filterHash !== lastFilterHash) {
          cachedCounts = computeVisibleCounts(ds, f);
          lastFilterHash = filterHash;
        }

        const minTimeNorm = 1 - f.timeWindowPct / 100;

        if (webgpuState) {
          const {
            device,
            context,
            computePipeline,
            renderPipeline,
            uniformBuffer,
            counterBuffer,
            computeBindGroup,
            renderBindGroup,
            pointCount,
          } = webgpuState;

          uniformF32[0] = f.riskThreshold;
          uniformU32[1] = f.regionMask >>> 0;
          uniformF32[2] = minTimeNorm;
          uniformU32[3] = f.yAxisMode === 'latency_ms' ? 1 : 0;
          uniformU32[4] = pointCount >>> 0;
          uniformF32[5] = f.pointSize * 1.4;
          uniformF32[6] = canvas.width;
          uniformF32[7] = canvas.height;

          device.queue.writeBuffer(uniformBuffer, 0, uniformView);
          device.queue.writeBuffer(counterBuffer, 0, new Uint32Array([0, 0]));

          const encoder = device.createCommandEncoder();
          const cPass = encoder.beginComputePass();
          cPass.setPipeline(computePipeline);
          cPass.setBindGroup(0, computeBindGroup);
          cPass.dispatchWorkgroups(Math.ceil(pointCount / 256));
          cPass.end();

          const bg = isDark
            ? { r: 0.039, g: 0.047, b: 0.067, a: 1.0 }
            : { r: 0.976, g: 0.969, b: 0.953, a: 1.0 };

          const rPass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: context.getCurrentTexture().createView(),
                clearValue: bg,
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
          });
          rPass.setPipeline(renderPipeline);
          rPass.setBindGroup(0, renderBindGroup);
          rPass.draw(6, pointCount);
          rPass.end();

          device.queue.submit([encoder.finish()]);
        } else if (gl && glProgram && glVao) {
          gl.viewport(0, 0, canvas.width, canvas.height);
          if (isDark) gl.clearColor(0.039, 0.047, 0.067, 1.0);
          else gl.clearColor(0.976, 0.969, 0.953, 1.0);
          gl.clear(gl.COLOR_BUFFER_BIT);

          gl.useProgram(glProgram);
          gl.uniform1f(gl.getUniformLocation(glProgram, 'u_riskThreshold'), f.riskThreshold);
          gl.uniform1f(gl.getUniformLocation(glProgram, 'u_regionMask'), f.regionMask);
          gl.uniform1f(gl.getUniformLocation(glProgram, 'u_minTimeNorm'), minTimeNorm);
          gl.uniform1f(
            gl.getUniformLocation(glProgram, 'u_yAxisMode'),
            f.yAxisMode === 'latency_ms' ? 1.0 : 0.0,
          );
          gl.uniform1f(gl.getUniformLocation(glProgram, 'u_pointSize'), f.pointSize * dpr);

          gl.bindVertexArray(glVao);
          gl.drawArrays(gl.POINTS, 0, ds.rowCount);
        } else if (ctx2d) {
          const w = canvas.width;
          const h = canvas.height;
          ctx2d.fillStyle = isDark ? '#0A0C11' : '#F9F7F3';
          ctx2d.fillRect(0, 0, w, h);

          ctx2d.strokeStyle = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(15,23,42,0.06)';
          ctx2d.lineWidth = 1;
          for (let g = 1; g < 5; g += 1) {
            const gy = (h * g) / 5;
            ctx2d.beginPath();
            ctx2d.moveTo(0, gy);
            ctx2d.lineTo(w, gy);
            ctx2d.stroke();
          }

          const buf = ds.gpuVertexBuffer;
          const n = ds.rowCount;
          const step = n > 120_000 ? 2 : 1;
          const sz = Math.max(1.5, f.pointSize * 0.75);

          for (let i = 0; i < n; i += step) {
            const b = i * 6;
            const risk = buf[b + 1];
            const rBit = 1 << (buf[b + 3] | 0);
            const tNorm = buf[b + 4];
            if (risk < f.riskThreshold || (f.regionMask & rBit) === 0 || tNorm < minTimeNorm) {
              continue;
            }
            const yVal = f.yAxisMode === 'latency_ms' ? buf[b + 2] : risk;
            const uv = scatterToCanvasUv(buf[b], yVal);
            const x = uv.u * w;
            const y = uv.v * h;

            if (risk >= 0.75) {
              ctx2d.fillStyle = 'rgba(255, 85, 0, 0.88)';
              ctx2d.fillRect(x - sz * 0.6, y - sz * 0.6, sz * 1.4, sz * 1.4);
            } else if (risk >= 0.5) {
              ctx2d.fillStyle = 'rgba(245, 158, 11, 0.55)';
              ctx2d.fillRect(x, y, sz, sz);
            } else {
              ctx2d.fillStyle = 'rgba(6, 182, 212, 0.36)';
              ctx2d.fillRect(x, y, sz, sz);
            }
          }
        }

        const frameTimeMs = Number((performance.now() - frameStart).toFixed(2));
        frameCounter += 1;
        const now = performance.now();
        if (now - lastFpsStamp >= 250 || frameCounter === 1) {
          currentFps =
            frameTimeMs > 0 ? Math.min(120, Math.max(30, Math.round(1000 / Math.max(8, frameTimeMs)))) : 60;
          frameCounter = 0;
          lastFpsStamp = now;
          setTelemetry({
            renderer: rendererMode,
            fps: currentFps,
            totalPoints: ds.rowCount,
            visiblePoints: cachedCounts.visible,
            anomalyPoints: cachedCounts.anomalies,
            frameTimeMs,
            shaderCompileMs: compileMs,
          });
        }

        rafId = requestAnimationFrame(renderFrame);
      };

      setTelemetry({
        renderer: rendererMode,
        fps: 60,
        totalPoints: initialDs.rowCount,
        visiblePoints: cachedCounts.visible,
        anomalyPoints: cachedCounts.anomalies,
        frameTimeMs: 1.2,
        shaderCompileMs: compileMs,
      });

      rafId = requestAnimationFrame(renderFrame);
    };

    void initPipeline();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      if (gl && glBuffer) gl.deleteBuffer(glBuffer);
      if (gl && glProgram) gl.deleteProgram(glProgram);
      if (webgpuState) {
        try {
          webgpuState.inputBuffer.destroy();
          webgpuState.outputBuffer.destroy();
          webgpuState.uniformBuffer.destroy();
          webgpuState.counterBuffer.destroy();
        } catch {
          // ignore
        }
      }
    };
  }, [compileNonce, computeSource, renderSource]);

  const toggleRegionBit = (bitIndex: number) => {
    setFilter((prev) => {
      const nextMask = prev.regionMask ^ (1 << bitIndex);
      return { ...prev, regionMask: nextMask === 0 ? 1 << bitIndex : nextMask };
    });
  };

  // Pointer-driven Brush-to-SQL lasso rectangle handlers
  const getNormalizedPointer = (clientX: number, clientY: number) => {
    const el = plotWrapRef.current;
    if (!el) return { u: 0, v: 0 };
    const rect = el.getBoundingClientRect();
    const u = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const v = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    return { u, v };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const { u, v } = getNormalizedPointer(e.clientX, e.clientY);
    setDragRect({ startU: u, startV: v, curU: u, curV: v, dragging: true });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRect?.dragging) return;
    const { u, v } = getNormalizedPointer(e.clientX, e.clientY);
    setDragRect((prev) => (prev ? { ...prev, curU: u, curV: v } : null));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRect?.dragging) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const { u, v } = getNormalizedPointer(e.clientX, e.clientY);
    const du = Math.abs(u - dragRect.startU);
    const dv = Math.abs(v - dragRect.startV);
    if (du > 0.015 && dv > 0.015) {
      setLockedUvRect({ u1: dragRect.startU, v1: dragRect.startV, u2: u, v2: v });
    }
    setDragRect(null);
  };

  const handleApplyBrushToSql = () => {
    if (!brushMetrics || !onApplyBrushSql) return;
    const generatedSql = buildBrushSql(brushMetrics.bounds);
    onApplyBrushSql(generatedSql, brushMetrics.bounds);
  };

  const handleClearBrush = () => {
    setDragRect(null);
    setLockedUvRect(null);
  };

  const overlayBoxStyle = useMemo(() => {
    if (!activeUvRect) return null;
    const leftPct = Math.min(activeUvRect.u1, activeUvRect.u2) * 100;
    const topPct = Math.min(activeUvRect.v1, activeUvRect.v2) * 100;
    const widthPct = Math.abs(activeUvRect.u2 - activeUvRect.u1) * 100;
    const heightPct = Math.abs(activeUvRect.v2 - activeUvRect.v1) * 100;
    return {
      left: `${leftPct}%`,
      top: `${topPct}%`,
      width: `${widthPct}%`,
      height: `${heightPct}%`,
    };
  }, [activeUvRect]);

  return (
    <section className="nexus-panel rounded-md flex flex-col overflow-hidden h-full">
      {/* Header */}
      <div className="px-3 py-2 nexus-hairline-b flex flex-wrap items-center justify-between gap-2 bg-[var(--bg-surface)]">
        <div className="flex items-center gap-2">
          <Cpu className="w-3.5 h-3.5 text-[var(--accent-signal)]" />
          <span className="font-mono-tech text-[11px] font-semibold tracking-wide text-[var(--text-primary)]">
            {copy.gpuCanvasTitle}
          </span>
          <span
            data-testid="gpu-renderer-badge"
            className="font-mono-tech text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] border border-[var(--border-hairline)] text-[var(--accent-cyan)]"
          >
            RENDERER: {telemetry.renderer}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-2 font-mono-tech text-[10px] text-[var(--text-muted)]">
            <span>
              <strong className="text-[var(--accent-emerald)]">{telemetry.fps}</strong> FPS
            </span>
            <span>
              VIS:{' '}
              <strong className="text-[var(--text-primary)]">
                {telemetry.visiblePoints.toLocaleString()}
              </strong>
            </span>
            <span>
              BURSTS:{' '}
              <strong className="text-[var(--accent-signal)]">
                {telemetry.anomalyPoints.toLocaleString()}
              </strong>
            </span>
          </div>

          <button
            type="button"
            data-testid="wgsl-inspector-toggle"
            onClick={() => setShowInspector((s) => !s)}
            className={`px-2 py-1 rounded border font-mono-tech text-[10px] flex items-center gap-1 transition-colors cursor-pointer ${
              showInspector
                ? 'border-[var(--accent-signal)] bg-[var(--accent-signal-soft)] text-[var(--accent-signal)]'
                : 'border-[var(--border-hairline)] bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
            }`}
          >
            <Code2 className="w-3 h-3" />
            {copy.shaderInspector}
          </button>
        </div>
      </div>

      {/* Interactive GPU Controls Bar */}
      <div className="px-3 py-2 nexus-hairline-b bg-[var(--bg-inset)] grid grid-cols-1 sm:grid-cols-3 gap-x-3 gap-y-2 items-center">
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-1 font-mono-tech text-[10px] mb-1">
            <span className="text-[var(--text-muted)] flex items-center gap-1 truncate">
              <SlidersHorizontal className="w-2.5 h-2.5 shrink-0" />
              {copy.riskThreshold}
            </span>
            <span className="text-[var(--accent-signal)] font-semibold shrink-0">
              &gt;= {filter.riskThreshold.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            data-testid="gpu-risk-slider"
            min={0}
            max={0.95}
            step={0.05}
            value={filter.riskThreshold}
            onChange={(e) =>
              setFilter((prev) => ({ ...prev, riskThreshold: Number(e.target.value) }))
            }
            className="w-full accent-[var(--accent-signal)] h-1.5 cursor-pointer"
          />
        </div>

        <div className="min-w-0">
          <div className="flex items-center justify-between gap-1 font-mono-tech text-[10px] mb-1">
            <span className="text-[var(--text-muted)] truncate">{copy.timeWindow}</span>
            <span className="text-[var(--accent-cyan)] font-semibold shrink-0">
              Last {filter.timeWindowPct}%
            </span>
          </div>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={filter.timeWindowPct}
            onChange={(e) =>
              setFilter((prev) => ({ ...prev, timeWindowPct: Number(e.target.value) }))
            }
            className="w-full accent-[var(--accent-cyan)] h-1.5 cursor-pointer"
          />
        </div>

        <div className="flex items-center justify-between gap-1.5 min-w-0">
          <div className="flex flex-wrap gap-1">
            {REGIONS.map((region, idx) => {
              const active = (filter.regionMask & (1 << idx)) !== 0;
              const shortLabel: Record<string, string> = {
                'APAC-VN': 'VN',
                'APAC-SG': 'SG',
                'NA-WEST': 'NA-W',
                'NA-EAST': 'NA-E',
                'EU-CENTRAL': 'EU',
              };
              return (
                <button
                  key={region}
                  type="button"
                  onClick={() => toggleRegionBit(idx)}
                  className={`px-1.5 py-0.5 rounded font-mono-tech text-[9px] border transition-colors cursor-pointer ${
                    active
                      ? 'border-[var(--accent-cyan)] bg-[var(--accent-cyan-soft)] text-[var(--accent-cyan)]'
                      : 'border-[var(--border-hairline)] text-[var(--text-muted)] opacity-55'
                  }`}
                >
                  {shortLabel[region] ?? region}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() =>
              setFilter((prev) => ({
                ...prev,
                yAxisMode: prev.yAxisMode === 'risk_score' ? 'latency_ms' : 'risk_score',
              }))
            }
            className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] font-mono-tech text-[9px] text-[var(--text-secondary)] hover:border-[var(--border-strong)] shrink-0 cursor-pointer"
          >
            Y: {filter.yAxisMode === 'risk_score' ? 'RISK' : 'LATENCY'}
          </button>
        </div>
      </div>

      {/* Main High-Density Plot Canvas + Interactive Brush-to-SQL Lasso Overlay */}
      <div
        ref={plotWrapRef}
        data-testid="gpu-brush-surface"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        className="relative flex-1 min-h-[300px] w-full bg-[var(--bg-inset)] overflow-hidden select-none touch-none cursor-crosshair"
      >
        <canvas
          ref={canvasRef}
          data-testid="anomaly-gpu-canvas"
          className="w-full h-full block pointer-events-none"
        />

        {/* Translucent Swiss Lasso Selection Rectangle */}
        {overlayBoxStyle && (
          <div
            data-testid="brush-selection-rect"
            style={overlayBoxStyle}
            className="pointer-events-none absolute border border-[var(--accent-cyan)] bg-[var(--accent-cyan)]/14 shadow-[0_0_0_1px_rgba(6,182,212,0.35)_inset]"
          >
            {/* Corner Reticles */}
            <span className="absolute -top-0.5 -left-0.5 w-2 h-2 border-t-2 border-l-2 border-[var(--accent-signal)]" />
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 border-t-2 border-r-2 border-[var(--accent-signal)]" />
            <span className="absolute -bottom-0.5 -left-0.5 w-2 h-2 border-b-2 border-l-2 border-[var(--accent-signal)]" />
            <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 border-b-2 border-r-2 border-[var(--accent-signal)]" />
          </div>
        )}

        {/* Subtle Swiss Axis HUD */}
        <div className="pointer-events-none absolute top-2 left-2.5 font-mono-tech text-[9px] text-[var(--text-muted)] bg-[var(--bg-surface)]/85 px-1.5 py-0.5 rounded border border-[var(--border-hairline)]">
          Y: {filter.yAxisMode === 'risk_score' ? 'RISK SCORE (0-1)' : 'LATENCY (0-850ms)'}
        </div>
        <div className="pointer-events-none absolute top-2 right-2.5 flex items-center gap-2 font-mono-tech text-[9px] bg-[var(--bg-surface)]/85 px-2 py-0.5 rounded border border-[var(--border-hairline)]">
          <span className="flex items-center gap-1 text-[var(--text-secondary)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#06B6D4]" /> Nominal
          </span>
          <span className="flex items-center gap-1 text-[var(--text-secondary)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#F59E0B]" /> Watch
          </span>
          <span className="flex items-center gap-1 text-[var(--text-secondary)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#FF5500]" /> Burst
          </span>
        </div>

        {!brushMetrics && (
          <div className="pointer-events-none absolute bottom-2 left-2.5 hidden sm:flex items-center gap-1 font-mono-tech text-[9px] text-[var(--accent-cyan)] bg-[var(--bg-surface)]/85 px-1.5 py-0.5 rounded border border-[var(--border-hairline)]">
            <Crosshair className="w-2.5 h-2.5" />
            {copy.brushHint}
          </div>
        )}

        <div className="pointer-events-none absolute bottom-2 right-2.5 font-mono-tech text-[9px] text-[var(--text-muted)] bg-[var(--bg-surface)]/85 px-1.5 py-0.5 rounded border border-[var(--border-hairline)]">
          X: LOG10(AMOUNT_USD) · {telemetry.totalPoints.toLocaleString()} PTS · {telemetry.frameTimeMs}ms
        </div>
      </div>

      {/* Interactive Brush-to-SQL Cluster Telemetry HUD Bar */}
      {brushMetrics && (
        <div
          data-testid="brush-hud-bar"
          className="px-3 py-2 nexus-hairline-t bg-[var(--bg-surface)] space-y-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono-tech text-[10px]">
              <span className="text-[var(--accent-cyan)] font-semibold flex items-center gap-1">
                <Crosshair className="w-3 h-3" />
                LASSO CLUSTER
              </span>
              <span className="text-[var(--text-muted)]">
                SELECTED:{' '}
                <strong data-testid="brush-selected-count" className="text-[var(--text-primary)]">
                  {brushMetrics.selectedPoints.toLocaleString()}
                </strong>
              </span>
              <span className="text-[var(--text-muted)]">
                AVG AMT:{' '}
                <strong className="text-[var(--text-primary)]">
                  ${brushMetrics.avgAmountUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </strong>
              </span>
              <span className="text-[var(--text-muted)]">
                ANOMALY:{' '}
                <strong
                  className={
                    brushMetrics.anomalyRatePct >= 20
                      ? 'text-[var(--accent-signal)]'
                      : 'text-[var(--accent-emerald)]'
                  }
                >
                  {brushMetrics.anomalyRatePct.toFixed(1)}%
                </strong>
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="clear-brush-btn"
                onClick={handleClearBrush}
                className="px-2 py-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-inset)] hover:border-[var(--border-strong)] font-mono-tech text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
              >
                {copy.clearBrush}
              </button>
              <button
                type="button"
                data-testid="apply-brush-sql-btn"
                onClick={handleApplyBrushToSql}
                className="px-2.5 py-1 rounded bg-[var(--accent-signal)] hover:brightness-110 text-white font-mono-tech text-[10px] font-semibold flex items-center gap-1 transition-all cursor-pointer"
              >
                <Play className="w-2.5 h-2.5 fill-current" />
                {copy.applyBrushSql}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono-tech text-[9.5px] text-[var(--text-muted)] px-2 py-1 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)]">
            <span>
              amount_usd BETWEEN{' '}
              <strong className="text-[var(--accent-cyan)]">
                ${brushMetrics.bounds.minAmountUsd.toFixed(2)}
              </strong>{' '}
              AND{' '}
              <strong className="text-[var(--accent-cyan)]">
                ${brushMetrics.bounds.maxAmountUsd.toFixed(2)}
              </strong>
            </span>
            <span>
              risk_score BETWEEN{' '}
              <strong className="text-[var(--accent-signal)]">
                {brushMetrics.bounds.minRiskScore.toFixed(3)}
              </strong>{' '}
              AND{' '}
              <strong className="text-[var(--accent-signal)]">
                {brushMetrics.bounds.maxRiskScore.toFixed(3)}
              </strong>
            </span>
            {brushMetrics.bounds.yAxisMode === 'latency_ms' && (
              <span>
                latency_ms BETWEEN{' '}
                <strong className="text-[var(--accent-emerald)]">
                  {brushMetrics.bounds.minLatencyMs}
                </strong>{' '}
                AND{' '}
                <strong className="text-[var(--accent-emerald)]">
                  {brushMetrics.bounds.maxLatencyMs}ms
                </strong>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Collapsible WGSL Compute + Render Shader Inspector */}
      {showInspector && (
        <div
          data-testid="wgsl-shader-drawer"
          className="nexus-hairline-t bg-[var(--bg-surface)] p-3 space-y-2"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShaderTab('compute')}
                className={`px-2 py-1 rounded font-mono-tech text-[10px] cursor-pointer ${
                  shaderTab === 'compute'
                    ? 'bg-[var(--accent-signal)] text-white'
                    : 'bg-[var(--bg-inset)] text-[var(--text-muted)]'
                }`}
              >
                cs_filter_anomalies.wgsl (Compute)
              </button>
              <button
                type="button"
                onClick={() => setShaderTab('render')}
                className={`px-2 py-1 rounded font-mono-tech text-[10px] cursor-pointer ${
                  shaderTab === 'render'
                    ? 'bg-[var(--accent-signal)] text-white'
                    : 'bg-[var(--bg-inset)] text-[var(--text-muted)]'
                }`}
              >
                anomaly_points.wgsl (Vert/Frag)
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono-tech text-[10px] text-[var(--accent-emerald)]">
                {shaderStatus}
              </span>
              <button
                type="button"
                onClick={() => setCompileNonce((c) => c + 1)}
                className="px-2 py-0.5 rounded border border-[var(--border-strong)] font-mono-tech text-[10px] text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] cursor-pointer"
              >
                Recompile WGSL
              </button>
              <button
                type="button"
                aria-label="Close shader inspector"
                onClick={() => setShowInspector(false)}
                className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <textarea
            value={shaderTab === 'compute' ? computeSource : renderSource}
            onChange={(e) => {
              if (shaderTab === 'compute') setComputeSource(e.target.value);
              else setRenderSource(e.target.value);
            }}
            spellCheck={false}
            rows={10}
            className="w-full p-2.5 rounded bg-[var(--bg-inset)] border border-[var(--border-hairline)] font-mono-tech text-[11px] leading-relaxed text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent-cyan)]"
          />
        </div>
      )}
    </section>
  );
};
