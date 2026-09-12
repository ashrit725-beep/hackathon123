import { useCallback, useEffect, useRef, useState } from "react";

/** Polls the development-context layer. Best-effort like useCenterData: a failing call never blanks the view. */
export function useCoreData(bridge, intervalMs = 4000, enabled = true) {
  const [data, setData] = useState({ loading: true });
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const calls = {
      overview: bridge.coreOverview(),
      sources: bridge.listSources(40),
      knowledge: bridge.listKnowledge(),
      plans: bridge.listPlans(),
      graph: bridge.coreGraph(),
      activity: bridge.coreActivity(40),
    };
    const entries = await Promise.all(Object.entries(calls).map(async ([k, p]) => [k, await p.catch((e) => ({ __error: e.message }))]));
    if (!alive.current) return;
    const ok = entries.filter(([, v]) => !(v && v.__error));
    setData((prev) => ({ ...prev, ...Object.fromEntries(ok), loading: false, error: ok.length ? null : entries[0][1].__error }));
  }, [bridge]);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return undefined;
    refresh();
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") refresh();
    }, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [refresh, intervalMs, enabled]);

  return { ...data, refresh };
}
