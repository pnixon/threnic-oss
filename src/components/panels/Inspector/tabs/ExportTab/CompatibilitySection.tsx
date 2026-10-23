/**
 * CompatibilitySection — global rendering-compatibility controls.
 *
 * Two things live here, both global (per-browser) preferences:
 *
 *   1. A persisted "Compatibility mode" toggle that pins the app to the
 *      Canvas2D/WebGL fallback renderer instead of WebGPU. Useful on hardware
 *      where WebGPU is flaky (old Linux/Mesa) — the user forces the stable
 *      path without editing the ?webgl=1 URL param.
 *
 *   2. A hardware-info readout showing what the startup probe actually found
 *      (WebGPU active / fallback + why, adapter vendor/architecture/backend),
 *      turning a silent "it didn't render" into a reportable state.
 *
 * Self-contained: it reads the diagnostics snapshot and drives localStorage
 * directly; toggling requires a reload because the renderer choice is made
 * once at startup in AppContent.
 */

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Cpu, MonitorCheck, MonitorX, RefreshCw } from 'lucide-react';
import {
  getWebGPUDiagnostics,
  isCompatibilityModeForced,
  setCompatibilityModeForced,
  resetWebGPUSupportCache,
  type WebGPUDiagnostics,
} from '@/engine/gpu/webgpu-support';

export function CompatibilitySection(): React.ReactElement {
  const [forced, setForced] = useState<boolean>(false);
  const [diag, setDiag] = useState<WebGPUDiagnostics | null>(null);

  // Read persisted state + the probe's captured diagnostics after mount.
  // The startup probe (checkWebGPUSupport in AppContent) has run by the time
  // the Inspector renders, so the snapshot is populated.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForced(isCompatibilityModeForced());
    setDiag(getWebGPUDiagnostics());
    // Refresh once shortly after mount in case the async adapter-info path
    // (deprecated requestAdapterInfo) resolved after the first read.
    const t = setTimeout(() => setDiag(getWebGPUDiagnostics()), 300);
    return () => clearTimeout(t);
  }, []);

  const handleToggle = useCallback(() => {
    const next = !forced;
    setCompatibilityModeForced(next);
    setForced(next);
    resetWebGPUSupportCache();
    // The renderer is selected once at startup; reload so the new choice takes
    // effect on the next detection pass.
    setTimeout(() => window.location.reload(), 150);
  }, [forced]);

  const handleRedetect = useCallback(() => {
    resetWebGPUSupportCache();
    window.location.reload();
  }, []);

  const supported = diag?.supported ?? null;
  const active = forced ? false : supported;

  const labelStyle: React.CSSProperties = {
    fontSize: '11px',
    color: 'var(--text-muted)',
    lineHeight: 1.5,
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        padding: 'var(--space-2)',
      }}
    >
      {/* Compatibility-mode toggle */}
      <div
        onClick={handleToggle}
        role="switch"
        aria-checked={forced}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          cursor: 'pointer',
          padding: '8px 12px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
          background: forced ? 'rgba(16,185,129,0.08)' : 'transparent',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Cpu size={14} style={{ opacity: 0.7 }} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: '12px', fontWeight: 600 }}>Compatibility mode</span>
            <span style={{ ...labelStyle, fontSize: '10px' }}>
              Force the fallback renderer (fixes black canvas on old GPUs)
            </span>
          </div>
        </div>
        <input
          type="checkbox"
          checked={forced}
          onChange={() => {}} // click handled by parent
          style={{
            cursor: 'pointer',
            accentColor: 'var(--color-primary)',
            pointerEvents: 'none',
          }}
        />
      </div>

      {/* Hardware-info readout */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          padding: '8px 12px',
          borderRadius: 'var(--radius-md)',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid var(--border-subtle, rgba(255,255,255,0.06))',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {active === true ? (
            <MonitorCheck size={14} style={{ color: '#10b981' }} />
          ) : (
            <MonitorX size={14} style={{ color: active === null ? '#94a3b8' : '#f59e0b' }} />
          )}
          <span style={{ fontSize: '12px', fontWeight: 600 }}>
            {active === null
              ? 'Detecting hardware…'
              : active
                ? 'WebGPU — hardware accelerated'
                : 'Compatibility renderer (WebGL/Canvas2D)'}
          </span>
        </div>

        <span style={labelStyle}>{diag?.reason ?? 'Detecting hardware…'}</span>

        {diag?.adapter && (
          <div
            style={{
              ...labelStyle,
              fontFamily: 'monospace',
              fontSize: '10px',
              opacity: 0.85,
              marginTop: '2px',
            }}
          >
            <div>GPU: {diag.adapter.description}</div>
            <div>
              vendor: {diag.adapter.vendor} · arch: {diag.adapter.architecture} · backend:{' '}
              {diag.adapter.backend}
            </div>
          </div>
        )}

        <button
          onClick={handleRedetect}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            alignSelf: 'flex-start',
            marginTop: '4px',
            fontSize: '10px',
            color: 'var(--text-muted)',
            background: 'transparent',
            border: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
            borderRadius: 'var(--radius-sm, 4px)',
            padding: '4px 8px',
            cursor: 'pointer',
          }}
          title="Clear the cached hardware verdict and re-detect (reloads the app)"
        >
          <RefreshCw size={11} />
          Re-detect hardware
        </button>
      </div>
    </div>
  );
}
