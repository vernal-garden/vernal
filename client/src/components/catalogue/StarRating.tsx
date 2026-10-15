// client/src/components/catalogue/StarRating.tsx
import { useState } from 'react';

interface Props {
  value: number | null;   // 0–5 (can be fractional for display)
  max?: number;
  interactive?: boolean;
  onChange?: (rating: number | null) => void;
  size?: number;
  label?: string;
  /** Mobile: give each interactive star a 44x44 hit area. */
  touchTarget?: boolean;
}

export default function StarRating({
  value,
  max = 5,
  interactive = false,
  onChange,
  size = 18,
  label,
  touchTarget = false,
}: Props) {
  const [hovered, setHovered] = useState<number | null>(null);

  const displayed = hovered ?? value ?? 0;

  function handleClick(star: number) {
    if (!interactive || !onChange) return;
    // clicking the same star clears the rating
    onChange(value === star ? null : star);
  }

  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
      aria-label={label ?? (value !== null ? `${value} out of ${max} stars` : 'Not rated')}
      role={interactive ? 'group' : undefined}
    >
      {Array.from({ length: max }, (_, i) => {
        const star = i + 1;
        const filled = displayed >= star;
        const half = !filled && displayed >= star - 0.5;
        return (
          <span
            key={star}
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}
            aria-label={interactive ? `${star} star${star !== 1 ? 's' : ''}` : undefined}
            onClick={() => handleClick(star)}
            // Mouse only: a touch tap fires enter without a matching leave, which would stick the hover fill.
            onPointerEnter={(e) => { if (interactive && e.pointerType === 'mouse') setHovered(star); }}
            onPointerLeave={(e) => { if (interactive && e.pointerType === 'mouse') setHovered(null); }}
            onKeyDown={(e) => { if (interactive && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); handleClick(star); } }}
            style={{
              cursor: interactive ? 'pointer' : 'default',
              display: 'inline-flex',
              color: filled || half ? '#C47A2A' : 'var(--c-border)',
              fontSize: size,
              lineHeight: 1,
              userSelect: 'none',
              ...(interactive && touchTarget
                ? { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }
                : {}),
            }}
          >
            {filled ? '★' : half ? <span style={{ opacity: 0.45 }}>★</span> : '☆'}
          </span>
        );
      })}
    </span>
  );
}
