import { useEffect, useState } from 'react';
import { getStoredTheme, setTheme, type Theme } from './theme';
import { SunIcon, MoonIcon, MonitorIcon } from './Icons';

const OPTIONS: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: 'system', label: 'System', icon: <MonitorIcon /> },
  { value: 'light', label: 'Light', icon: <SunIcon /> },
  { value: 'dark', label: 'Dark', icon: <MoonIcon /> },
];

export default function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  // Keep the control in sync if another tab changes the stored preference.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'printsort3d-theme') setThemeState(getStoredTheme());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const choose = (value: Theme) => {
    setTheme(value);
    setThemeState(value);
  };

  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`theme-toggle-option${theme === opt.value ? ' active' : ''}`}
          aria-pressed={theme === opt.value}
          title={opt.label}
          onClick={() => choose(opt.value)}
        >
          {opt.icon}
          <span>{opt.label}</span>
        </button>
      ))}
    </div>
  );
}
