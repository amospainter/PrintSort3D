import type { MouseEvent } from 'react';
import { tagChipStyle } from './tagColors';

interface TagChipProps {
  name: string;
  color?: string | null; // explicit hex, or undefined/null to use the auto palette colour
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  title?: string;
}

// Colour-coded tag pill used across the library and detail views. Clickable variant is used
// as a "filter by this tag" affordance inside <Link> cards, so it stops event propagation.
export function TagChip({ name, color, onClick, title }: TagChipProps) {
  const style = tagChipStyle(name, color);
  const className = `tag-chip${onClick ? ' tag-chip--clickable' : ''}`;
  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        style={style}
        title={title}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClick(e);
        }}
      >
        {name}
      </button>
    );
  }
  return (
    <span className={className} style={style} title={title}>
      {name}
    </span>
  );
}
