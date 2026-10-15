import type { ReactNode, SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'>;

function Icon({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

// A leaf with a centre vein.
export function GardensIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15" />
      <path d="M5 19l8-8" />
    </Icon>
  );
}

// A square split into a 2x2 grid.
export function CanvasIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M12 4v16M4 12h16" />
    </Icon>
  );
}

// A seedling: stem with two leaves above the soil line.
export function PlantingIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 20v-9" />
      <path d="M12 11c0-3-2-5-6-5 0 3 2 5 6 5z" />
      <path d="M12 13c0-3 2-5 6-5 0 3-2 5-6 5z" />
      <path d="M7 20h10" />
    </Icon>
  );
}

// A seed packet with a folded top and a seed on the front.
export function CatalogueIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 7h12v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z" />
      <path d="M6 7l1.5-3h9L18 7" />
      <ellipse cx="12" cy="13.5" rx="2" ry="3" />
    </Icon>
  );
}

// A sun partly behind a cloud.
export function WeatherIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 3v1.5M3.5 8.5H5M4.8 4.3l1 1M13.2 4.3l-1 1" />
      <path d="M5.6 11.2A3.5 3.5 0 1 1 12.4 7" />
      <path d="M8 20h9a3.5 3.5 0 0 0 0-7h-.3A5 5 0 0 0 7 14a3 3 0 0 0 1 6z" />
    </Icon>
  );
}

// A woven basket with a handle.
export function HarvestIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 10a4 4 0 0 1 8 0" />
      <path d="M3.5 10h17l-1.6 8.4a2 2 0 0 1-2 1.6H7.1a2 2 0 0 1-2-1.6z" />
      <path d="M9 13.5v3M12 13.5v3M15 13.5v3" />
    </Icon>
  );
}

export function BackIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15 5l-7 7 7 7" />
    </Icon>
  );
}

export function MonitorIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M9 20h6M12 16v4" />
    </Icon>
  );
}

// A bell with a clapper.
export function BellIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
      <path d="M10 21h4" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}
