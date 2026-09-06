// Theme override: "system" (follow the OS via prefers-color-scheme) is the default;
// "light"/"dark" pin the palette regardless of the OS. The choice is a per-browser UI
// preference, so it lives in localStorage — not in the server's config.json.
//
// The initial value is applied before React (and before first paint) by the inline
// script in index.html, so switching devices/tabs never flashes the wrong palette.
// This module is the single source of truth for reading/writing it at runtime.

export type Theme = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'printsort3d-theme';

export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // localStorage can throw in private-mode / sandboxed contexts — fall through.
  }
  return 'system';
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

export function setTheme(theme: Theme): void {
  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Non-fatal: the attribute below still updates this session.
  }
  applyTheme(theme);
}
