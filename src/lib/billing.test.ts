import { describe, it, expect, beforeEach, vi } from 'vitest';
import Stripe from 'stripe';

vi.mock('./stripe', () => ({
  stripe: {
    subscriptions: { retrieve: vi.fn(), update: vi.fn(), cancel: vi.fn() },
    customers: { del: vi.fn() },
  },
}));

import { stripe } from './stripe';
import { stopRenewal, resumeRenewal, teardownCustomer } from './billing';

const subs = vi.mocked(stripe.subscriptions);
const customers = vi.mocked(stripe.customers);

function missing(): Error {
  return new Stripe.errors.StripeInvalidRequestError({
    type: 'invalid_request_error',
    code: 'resource_missing',
    message: 'No such object',
  });
}

beforeEach(() => vi.resetAllMocks());

describe('stopRenewal', () => {
  it('sets cancel_at_period_end on an active subscription', async () => {
    subs.retrieve.mockResolvedValue({ status: 'active' } as never);
    await stopRenewal('sub_1');
    expect(subs.update).toHaveBeenCalledWith('sub_1', {
      cancel_at_period_end: true,
      metadata: { vernal_deletion_pause: '1' },
    });
  });

  it('does nothing when the user already cancelled renewal', async () => {
    subs.retrieve.mockResolvedValue({ status: 'active', cancel_at_period_end: true } as never);
    await stopRenewal('sub_1');
    expect(subs.update).not.toHaveBeenCalled();
  });

  it('does nothing for an incomplete subscription', async () => {
    subs.retrieve.mockResolvedValue({ status: 'incomplete' } as never);
    await stopRenewal('sub_1');
    expect(subs.update).not.toHaveBeenCalled();
  });

  it('does nothing for a canceled or missing subscription', async () => {
    subs.retrieve.mockResolvedValueOnce({ status: 'canceled' } as never);
    await stopRenewal('sub_1');
    subs.retrieve.mockRejectedValueOnce(missing());
    await stopRenewal('sub_2');
    expect(subs.update).not.toHaveBeenCalled();
  });

  it('propagates other Stripe errors', async () => {
    subs.retrieve.mockRejectedValue(new Error('network down'));
    await expect(stopRenewal('sub_1')).rejects.toThrow('network down');
  });
});

describe('resumeRenewal', () => {
  it('clears cancel_at_period_end and the marker when we set it', async () => {
    subs.retrieve.mockResolvedValue({
      status: 'active',
      metadata: { vernal_deletion_pause: '1' },
    } as never);
    await resumeRenewal('sub_1');
    expect(subs.update).toHaveBeenCalledWith('sub_1', {
      cancel_at_period_end: false,
      metadata: { vernal_deletion_pause: '' },
    });
  });

  it('does nothing without the marker (user cancelled themselves)', async () => {
    subs.retrieve.mockResolvedValue({ status: 'active', cancel_at_period_end: true, metadata: {} } as never);
    await resumeRenewal('sub_1');
    expect(subs.update).not.toHaveBeenCalled();
  });

  it('does nothing for a canceled subscription', async () => {
    subs.retrieve.mockResolvedValue({ status: 'canceled' } as never);
    await resumeRenewal('sub_1');
    expect(subs.update).not.toHaveBeenCalled();
  });
});

describe('teardownCustomer', () => {
  it('cancels an active subscription then deletes the customer', async () => {
    subs.retrieve.mockResolvedValue({ status: 'active' } as never);
    await teardownCustomer({ subId: 'sub_1', customerId: 'cus_1' });
    expect(subs.cancel).toHaveBeenCalledWith('sub_1');
    expect(customers.del).toHaveBeenCalledWith('cus_1');
  });

  it.each(['canceled', 'incomplete_expired'])(
    'skips cancel for a %s subscription but still deletes the customer',
    async (status) => {
      subs.retrieve.mockResolvedValue({ status } as never);
      await teardownCustomer({ subId: 'sub_1', customerId: 'cus_1' });
      expect(subs.cancel).not.toHaveBeenCalled();
      expect(customers.del).toHaveBeenCalledWith('cus_1');
    },
  );

  it('tolerates already-gone objects', async () => {
    subs.retrieve.mockRejectedValue(missing());
    customers.del.mockRejectedValue(missing());
    await expect(teardownCustomer({ subId: 'sub_1', customerId: 'cus_1' })).resolves.toBeUndefined();
  });

  it('skips null ids', async () => {
    await teardownCustomer({ subId: null, customerId: null });
    expect(subs.retrieve).not.toHaveBeenCalled();
    expect(customers.del).not.toHaveBeenCalled();
  });

  it('propagates other errors', async () => {
    customers.del.mockRejectedValue(new Error('stripe 500'));
    await expect(teardownCustomer({ subId: null, customerId: 'cus_1' })).rejects.toThrow('stripe 500');
  });
});
