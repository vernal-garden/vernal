import React, { createContext, useContext, useEffect, useState } from 'react';
import { apiUrl } from '../lib/api';

// ── Public types ─────────────────────────────────────────────────────────────

export type PrivateBetaVersion = 'applications_open' | 'applications_closed';

// The shape of GET /api/config.
export interface ServerConfig {
  billing: boolean;
  mail: boolean;
  googleSignIn: boolean;
  weather: boolean;
  betaGate: boolean;
  guestMode: boolean;
  privateBetaVersion: PrivateBetaVersion;
}

// ── Loading ───────────────────────────────────────────────────────────────────

// Today's behaviour, used when the config can't be read. The server still
// enforces every rule, so this only affects what is shown.
const DEFAULT_CONFIG: ServerConfig = {
  billing: true,
  mail: true,
  googleSignIn: true,
  weather: true,
  betaGate: false,
  guestMode: true,
  privateBetaVersion: 'applications_open',
};

// The routes wait for the config, so a hung request must not blank the app.
const CONFIG_TIMEOUT_MS = 5000;

// Never rejects and never retries: any failure settles on the defaults.
async function loadConfig(signal: AbortSignal): Promise<ServerConfig> {
  try {
    const res = await fetch(apiUrl('/api/config'), { credentials: 'include', signal });
    if (!res.ok) return DEFAULT_CONFIG;
    return { ...DEFAULT_CONFIG, ...((await res.json()) as Partial<ServerConfig>) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

// Null until the config settles.
const ConfigContext = createContext<ServerConfig | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

// Always renders its children, so AuthProvider's session call starts alongside
// this one. ConfigGate is what holds back anything that reads the config.
export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<ServerConfig | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);
    let active = true;

    void loadConfig(controller.signal).then(loaded => {
      window.clearTimeout(timeout);
      if (active) setConfig(loaded);
    });

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

// ── Gate ──────────────────────────────────────────────────────────────────────

export function ConfigGate({ children }: { children: React.ReactNode }) {
  return useContext(ConfigContext) ? <>{children}</> : null;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useConfig(): ServerConfig {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error('useConfig must be called within <ConfigGate>');
  return ctx;
}
