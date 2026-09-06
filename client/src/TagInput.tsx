import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { tagChipStyle } from './tagColors';

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
  placeholder?: string;
  className?: string;
  // Explicit colour overrides (from api.listTags()'s TagInfo, via tagColors.tagColorMap) —
  // a tag with no entry here still gets a stable colour from tagChipStyle's name-hash
  // fallback, so chips are never left flat/uncoloured even before this is wired up.
  colors?: Map<string, string | null>;
  // Notified as the user types in the not-yet-committed input. Lets a parent "Save" button
  // fold in a tag the user typed but never pressed Enter on — see Detail.tsx's saveTags.
  onDraftChange?: (draft: string) => void;
}

// Chip-style tag editor with a live-filtered autocomplete dropdown drawn from the
// catalog's existing tag vocabulary (api.listTags()) — lets you reuse an existing tag by
// typing a few letters instead of retyping it exactly, and still add a brand-new tag by
// typing one that doesn't match anything and pressing Enter/comma.
export function TagInput({ value, onChange, suggestions, placeholder, className, colors, onDraftChange }: TagInputProps) {
  const [draft, setDraftState] = useState('');
  const setDraft = (v: string) => {
    setDraftState(v);
    onDraftChange?.(v);
  };
  const [highlighted, setHighlighted] = useState(0);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = draft.trim()
    ? suggestions.filter((s) => s.toLowerCase().includes(draft.trim().toLowerCase()) && !value.includes(s)).slice(0, 8)
    : [];

  useEffect(() => setHighlighted(0), [draft]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const commit = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (!tag || value.includes(tag)) {
      setDraft('');
      return;
    }
    onChange([...value, tag]);
    setDraft('');
    setOpen(false);
  };

  const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i));

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      if (!draft.trim()) return;
      e.preventDefault();
      commit(open && filtered.length > 0 ? filtered[highlighted] ?? filtered[0] : draft);
    } else if (e.key === 'Backspace' && !draft && value.length > 0) {
      removeAt(value.length - 1);
    } else if (e.key === 'ArrowDown' && filtered.length > 0) {
      e.preventDefault();
      setOpen(true);
      setHighlighted((h) => (h + 1) % filtered.length);
    } else if (e.key === 'ArrowUp' && filtered.length > 0) {
      e.preventDefault();
      setHighlighted((h) => (h - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className={`tag-input${className ? ` ${className}` : ''}`} ref={containerRef}>
      {value.map((t, i) => (
        <span className="tag-chip tag-chip--editable" key={t} style={tagChipStyle(t, colors?.get(t))}>
          {t}
          <button type="button" className="tag-chip-remove" onClick={() => removeAt(i)} aria-label={`Remove tag ${t}`}>
            ×
          </button>
        </span>
      ))}
      <input
        className="tag-input-field"
        value={draft}
        placeholder={value.length === 0 ? placeholder : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Commit whatever's half-typed when focus leaves the field (e.g. the user typed a
          // tag and clicked "Save tags" without pressing Enter first). The suggestion buttons
          // use onMouseDown+preventDefault, so picking one doesn't trigger this.
          if (draft.trim()) commit(draft);
        }}
        onKeyDown={handleKeyDown}
      />
      {open && filtered.length > 0 && (
        <ul className="tag-suggestions">
          {filtered.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                className={i === highlighted ? 'active' : ''}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(s)}
              >
                <span className="tag-suggestion-swatch" style={{ backgroundColor: tagChipStyle(s, colors?.get(s)).backgroundColor }} />
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
