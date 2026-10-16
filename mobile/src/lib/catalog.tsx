import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api, Species } from './api';

type CatalogState = {
  list: Species[];
  bySpecies: Record<string, Species>;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  threshold: number;
  setThreshold: (value: number) => Promise<void>;
  reload: () => void;
};

const Ctx = createContext<CatalogState | null>(null);

export function CatalogProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Species[]>([]);
  const [status, setStatus] = useState<CatalogState['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(0.9);

  const reload = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const [health, species] = await Promise.all([
        api.get<{ threshold: number }>('/api/m/health', 8000),
        api.get<Species[]>('/api/m/species'),
      ]);
      setThreshold(health.threshold);
      setList(species);
      setStatus('ready');
    } catch (e: any) {
      setError(e.message);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // le seuil est gardé par le serveur (data/igdad/settings.json) : il s'applique à toutes les analyses
  const updateThreshold = useCallback(async (value: number) => {
    const r = await api.post<{ threshold: number }>('/api/m/settings', { threshold: value });
    setThreshold(r.threshold);
  }, []);

  const value = useMemo(
    () => ({
      list,
      bySpecies: Object.fromEntries(list.map((s) => [s.species, s])),
      status,
      error,
      threshold,
      setThreshold: updateThreshold,
      reload,
    }),
    [list, status, error, threshold, updateThreshold, reload],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCatalog(): CatalogState {
  const c = useContext(Ctx);
  if (!c) throw new Error('CatalogProvider manquant');
  return c;
}

export function displayName(s?: Species | null, fallback = ''): string {
  return s?.fr || s?.en || s?.sci || fallback.replace('_', ' ');
}
