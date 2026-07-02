// client/src/components/catalogue/IllustrationImage.tsx
import { useEffect, useState } from 'react';

interface Props {
  illustrationKey: string | null;
  size?: number;
  className?: string;
}

function PlantFallbackSvg({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect width="64" height="64" rx="8" fill="var(--c-primary-subtle)" />
      {/* Stem */}
      <line x1="32" y1="52" x2="32" y2="28" stroke="var(--c-primary)" strokeWidth="2.5" strokeLinecap="round" />
      {/* Left leaf */}
      <path
        d="M32 38 C22 34 18 24 24 18 C28 26 32 30 32 38Z"
        fill="var(--c-primary-light)"
        stroke="var(--c-primary)"
        strokeWidth="1.2"
      />
      {/* Right leaf */}
      <path
        d="M32 32 C42 28 46 18 40 12 C36 20 32 24 32 32Z"
        fill="var(--c-primary-light)"
        stroke="var(--c-primary)"
        strokeWidth="1.2"
      />
      {/* Soil */}
      <ellipse cx="32" cy="52" rx="10" ry="3" fill="var(--c-surface-raised)" />
    </svg>
  );
}

export default function IllustrationImage({ illustrationKey, size = 80, className }: Props) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [illustrationKey]);

  if (!illustrationKey || failed) {
    return (
      <span className={className} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        <PlantFallbackSvg size={size} />
      </span>
    );
  }

  return (
    <img
      src={illustrationKey}
      alt=""
      width={size}
      height={size}
      className={className}
      loading="lazy"
      style={{ objectFit: 'contain' }}
      onError={() => setFailed(true)}
    />
  );
}
