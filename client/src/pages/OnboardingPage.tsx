import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import { useAuth } from '../context/AuthContext';

type Method = 'square_foot' | 'raised_bed' | 'container' | 'in_ground' | '';

const methodToStyle: Record<Exclude<Method, ''>, 'grid' | 'freeform'> = {
  square_foot: 'grid',
  raised_bed: 'grid',
  container: 'freeform',
  in_ground: 'freeform',
};

const METHOD_OPTIONS: { value: Exclude<Method, ''>; label: string; description: string }[] = [
  { value: 'square_foot', label: 'Square foot', description: 'Divide your space into a grid of square-foot sections' },
  { value: 'raised_bed',  label: 'Raised bed',  description: 'Defined beds above ground level' },
  { value: 'container',   label: 'Container',   description: 'Pots, planters, and anything that moves' },
  { value: 'in_ground',   label: 'In-ground',   description: 'Traditional rows or free-form planting in the soil' },
];

export default function OnboardingPage() {
  const { isAccount, gardenCount, refetch } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<1 | 2>(1);
  const [locationLabel, setLocationLabel] = useState('');
  const [zone, setZone] = useState('');
  const [gardenName, setGardenName] = useState('My Garden');
  const [method, setMethod] = useState<Method>('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Guard: already onboarded
  if (gardenCount !== null && gardenCount > 0) {
    return <Navigate to="/" replace />;
  }

  const step1Valid = locationLabel.trim().length > 0 && zone.trim().length > 0;
  const step2Valid = method !== '' && gardenName.trim().length > 0;

  async function completeOnboarding() {
    if (!method) return;
    setLoading(true);
    setError('');
    try {
      const style = methodToStyle[method as Exclude<Method, ''>];
      await api.post('/api/gardens', {
        name: gardenName.trim(),
        style,
        zone: zone.trim(),
        zoneLocationLabel: locationLabel.trim(),
        growingMethod: method,
      });
      if (isAccount) {
        await api.patch('/api/me', {
          zone: zone.trim(),
          zoneLocationLabel: locationLabel.trim(),
        });
      }
      await refetch();
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof api.ApiError) {
        const body = err.body as { error?: string } | null;
        setError(body?.error ?? 'Something went wrong');
      } else {
        setError('Something went wrong');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f5f5f0] p-4">
      <div className="bg-white rounded-xl p-10 w-full max-w-lg shadow-[0_2px_12px_rgba(0,0,0,0.08)]">

        {/* Step indicator */}
        <div className="flex gap-2 mb-8">
          <div className="h-1.5 flex-1 rounded-full bg-[#4f7c3f]" />
          <div className={`h-1.5 flex-1 rounded-full ${step === 2 ? 'bg-[#4f7c3f]' : 'bg-gray-200'}`} />
        </div>

        {step === 1 && (
          <>
            <h1 className="text-2xl font-semibold text-[#1a1a1a] mb-6">Where are you gardening?</h1>

            <div className="mb-5">
              <label htmlFor="location" className="block mb-1.5 text-sm font-medium text-gray-700">
                Location
              </label>
              <input
                id="location"
                type="text"
                placeholder="e.g. Richmond, VA"
                value={locationLabel}
                onChange={e => setLocationLabel(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md text-[0.9375rem] text-[#1a1a1a] outline-none"
              />
            </div>

            <div className="mb-6">
              <label htmlFor="zone" className="block mb-1.5 text-sm font-medium text-gray-700">
                Hardiness zone
              </label>
              <input
                id="zone"
                type="text"
                placeholder="e.g. 7b"
                value={zone}
                onChange={e => setZone(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md text-[0.9375rem] text-[#1a1a1a] outline-none"
              />
              <p className="mt-1.5 text-sm text-gray-500">
                Not sure?{' '}
                <a
                  href="https://planthardiness.ars.usda.gov"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#4f7c3f] underline"
                >
                  Look it up
                </a>
              </p>
            </div>

            <button
              type="button"
              disabled={!step1Valid}
              onClick={() => setStep(2)}
              className="block w-full py-2.5 px-4 bg-[#4f7c3f] text-white rounded-md text-[0.9375rem] font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Continue
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="text-2xl font-semibold text-[#1a1a1a] mb-6">How do you grow?</h1>

            <div className="grid grid-cols-2 gap-3 mb-6">
              {METHOD_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setMethod(opt.value)}
                  className={`text-left p-4 rounded-lg border-2 transition-colors ${
                    method === opt.value
                      ? 'border-[#4f7c3f] bg-[#f0f7ed]'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="text-sm font-medium text-[#1a1a1a] mb-1">{opt.label}</div>
                  <div className="text-xs text-gray-500 leading-snug">{opt.description}</div>
                </button>
              ))}
            </div>

            <div className="mb-6">
              <label htmlFor="garden-name" className="block mb-1.5 text-sm font-medium text-gray-700">
                Garden name
              </label>
              <input
                id="garden-name"
                type="text"
                value={gardenName}
                onChange={e => setGardenName(e.target.value)}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md text-[0.9375rem] text-[#1a1a1a] outline-none"
              />
            </div>

            {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

            <button
              type="button"
              disabled={!step2Valid || loading}
              onClick={completeOnboarding}
              className="block w-full py-2.5 px-4 bg-[#4f7c3f] text-white rounded-md text-[0.9375rem] font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Setting up…' : 'Start planning'}
            </button>
          </>
        )}

      </div>
    </div>
  );
}
