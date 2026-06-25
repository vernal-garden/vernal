import type { FitResult } from '../../lib/fit';

interface Props {
  fit: FitResult;
  name: string;
  spacingInches: number;
}

export default function FitLine({ fit, name, spacingInches }: Props) {
  let headline: string;
  let context: string;

  switch (fit.mode) {
    case 'sfg':
      headline = `${fit.perCell} per square`;
      context = `${fit.total} total · ${name} · ${spacingInches} in. spacing`;
      break;
    case 'sfg-large':
      headline = `1 per ${fit.squaresPer} squares`;
      context = `${fit.total} total · ${name} · ${spacingInches} in. spacing`;
      break;
    case 'grid':
      headline = `${fit.total}`;
      context = `${name} · ${spacingInches} in. spacing`;
      break;
    case 'freeform':
      headline = `~${fit.total}`;
      context = `approx · ${name} · ${spacingInches} in. spacing`;
      break;
  }

  return (
    <div style={{ background: '#f0ebe0', border: '1px solid #d8ceba', borderRadius: 8, padding: '10px 14px' }}>
      <div style={{
        fontFamily: "'Fraunces', Georgia, serif",
        fontSize: 20,
        fontWeight: 600,
        color: '#1c3a28',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        lineHeight: 1.2,
        marginBottom: 4,
      }}>
        {headline}
      </div>
      <div style={{ fontSize: 13, color: '#5a4e3a', lineHeight: 1.4 }}>
        {context}
      </div>
    </div>
  );
}
