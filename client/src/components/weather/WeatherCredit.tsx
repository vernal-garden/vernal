import type React from 'react';
import { secondaryTextStyle } from '../metrics/styles';

export const WEATHER_PROVIDER_CREDIT = {
  text: 'Weather data provided by Visual Crossing Weather',
  href: 'https://www.visualcrossing.com/',
} as const;

export const LOCATION_CREDIT = {
  text: 'Location search © OpenStreetMap contributors',
  href: 'https://www.openstreetmap.org/copyright',
} as const;

type SpacingStyle = Pick<
  React.CSSProperties,
  'margin' | 'marginTop' | 'marginBottom' | 'marginLeft' | 'marginRight' | 'marginBlock' | 'marginInline'
>;

const linkStyle: React.CSSProperties = {
  color: 'var(--c-primary)',
  textDecoration: 'underline',
};

// Attribution for the weather and location services. Inline links in a sentence.
export default function WeatherCredit({ style }: { style?: SpacingStyle }) {
  return (
    <p
      data-testid="weather-credit"
      style={{ ...secondaryTextStyle, margin: 0, fontFamily: 'var(--font-ui)', ...style }}
    >
      <a href={WEATHER_PROVIDER_CREDIT.href} target="_blank" rel="noopener noreferrer" style={linkStyle}>
        {WEATHER_PROVIDER_CREDIT.text}
      </a>
      {' · '}
      <a href={LOCATION_CREDIT.href} target="_blank" rel="noopener noreferrer" style={linkStyle}>
        {LOCATION_CREDIT.text}
      </a>
    </p>
  );
}
