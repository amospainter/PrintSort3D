import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ScanStatus } from './api';

const IDLE: ScanStatus = {
  scanning: false,
  pendingReprocess: 0,
  progress: {
    running: false,
    phase: 'idle',
    mode: 'scan',
    rootLabel: null,
    total: 0,
    processed: 0,
    added: 0,
    updated: 0,
    missing: 0,
    currentFile: null,
    startedAt: null,
    finishedAt: null,
    error: null,
  },
};

/**
 * Polls /api/scan/status. Polls fast (1s) while a scan is running, slowly (15s) when idle so
 * a scan started elsewhere (another tab, SCAN_ON_STARTUP) still shows up. `refresh()` forces
 * an immediate poll — call it right after kicking off a scan.
 */
export function useScanStatus(): { status: ScanStatus; refresh: () => void } {
  const [status, setStatus] = useState<ScanStatus>(IDLE);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const poll = useCallback(() => {
    api
      .getScanStatus()
      .then((s) => {
        if (!alive.current) return;
        setStatus(s);
        timer.current = setTimeout(poll, s.scanning ? 1000 : 15000);
      })
      .catch(() => {
        if (alive.current) timer.current = setTimeout(poll, 15000);
      });
  }, []);

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    poll();
  }, [poll]);

  useEffect(() => {
    alive.current = true;
    poll();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll]);

  return { status, refresh };
}
