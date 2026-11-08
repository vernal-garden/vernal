import { describe, it, expect, beforeEach, vi } from 'vitest';
import Stripe from 'stripe';

vi.mock('./stripe', () => {
  const stripe = {
    subscriptions: { retrieve: vi.fn(), update: vi.fn(), cancel: vi.fn(), list: vi.fn() },
    customers: { del: vi.fn(), update: vi.fn(), createBalanceTransaction: vi.fn(), listBalanceTransactions: vi.fn() },
    invoices: { retrieve: vi.fn(), list: vi.fn(), voidInvoice: vi.fn() },
    invoicePayments: { list: vi.fn() },
    refunds: { list: vi.fn(), create: vi.fn() },
    checkout: { sessions: { list: vi.fn(), expire: vi.fn() } },
  };
  const state = { configured: true };
  return {
    getStripe: () => stripe,
    getStripeForCleanup: () => (state.configured ? stripe : null),
    __state: state,
  };
});

vi.mock('./logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { getStripe } from './stripe';
import * as stripeModule from './stripe';
import { logger } from './logger';
const stripe = getStripe();
const stripeState = (stripeModule as unknown as { __state: { configured: boolean } }).__state;
import {
  stopRenewal,
  resumeRenewal,
  teardownCustomer,
  cancelAndRefundUnused,
  liveSubscriptionIds,
  forgetCustomerContact,
  expireOpenCheckoutSessions,
} from './billing';

const subs = vi.mocked(stripe.subscriptions);
const customers = vi.mocked(stripe.customers);
const invoices = vi.mocked(stripe.invoices);
const invoicePayments = vi.mocked(stripe.invoicePayments);
const refunds = vi.mocked(stripe.refunds);
const checkoutSessions = vi.mocked(stripe.checkout.sessions);

function missing(): Error {
  return new Stripe.errors.StripeInvalidRequestError({
    type: 'invalid_request_error',
    code: 'resource_missing',
    message: 'No such object',
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  stripeState.configured = true;
});

describe('stopRenewal', () => {
  it('sets cancel_at_period_end on an active subscription', async () => {
    subs.retrieve.mockResolvedValue({ status: 'active' } as never);
    await stopRenewal('sub_1', 1);
    expect(subs.update).toHaveBeenCalledWith('sub_1', {
      cancel_at_period_end: true,
      metadata: { vernal_deletion_pause: '1' },
    });
  });

  it('does nothing when the user already cancelled renewal', async () => {
    subs.retrieve.mockResolvedValue({ status: 'active', cancel_at_period_end: true } as never);
    await stopRenewal('sub_1', 1);
    expect(subs.update).not.toHaveBeenCalled();
  });

  it('does nothing for an incomplete subscription', async () => {
    subs.retrieve.mockResolvedValue({ status: 'incomplete' } as never);
    await stopRenewal('sub_1', 1);
    expect(subs.update).not.toHaveBeenCalled();
  });

  it('does nothing for a canceled or missing subscription', async () => {
    subs.retrieve.mockResolvedValueOnce({ status: 'canceled' } as never);
    await stopRenewal('sub_1', 1);
    subs.retrieve.mockRejectedValueOnce(missing());
    await stopRenewal('sub_2', 1);
    expect(subs.update).not.toHaveBeenCalled();
  });

  it('propagates other Stripe errors', async () => {
    subs.retrieve.mockRejectedValue(new Error('network down'));
    await expect(stopRenewal('sub_1', 1)).rejects.toThrow('network down');
  });
});

describe('resumeRenewal', () => {
  it('clears cancel_at_period_end and the marker when we set it', async () => {
    subs.retrieve.mockResolvedValue({
      status: 'active',
      metadata: { vernal_deletion_pause: '1' },
    } as never);
    await resumeRenewal('sub_1', 1);
    expect(subs.update).toHaveBeenCalledWith('sub_1', {
      cancel_at_period_end: false,
      metadata: { vernal_deletion_pause: '' },
    });
  });

  it('does nothing without the marker (user cancelled themselves)', async () => {
    subs.retrieve.mockResolvedValue({ status: 'active', cancel_at_period_end: true, metadata: {} } as never);
    await resumeRenewal('sub_1', 1);
    expect(subs.update).not.toHaveBeenCalled();
  });

  it('does nothing for a canceled subscription', async () => {
    subs.retrieve.mockResolvedValue({ status: 'canceled' } as never);
    await resumeRenewal('sub_1', 1);
    expect(subs.update).not.toHaveBeenCalled();
  });
});

describe('teardownCustomer', () => {
  it('cancels an active subscription then deletes the customer', async () => {
    subs.retrieve.mockResolvedValue({ status: 'active' } as never);
    await teardownCustomer({ subId: 'sub_1', customerId: 'cus_1', accountId: 1 });
    expect(subs.cancel).toHaveBeenCalledWith('sub_1');
    expect(customers.del).toHaveBeenCalledWith('cus_1');
  });

  it.each(['canceled', 'incomplete_expired'])(
    'skips cancel for a %s subscription but still deletes the customer',
    async (status) => {
      subs.retrieve.mockResolvedValue({ status } as never);
      await teardownCustomer({ subId: 'sub_1', customerId: 'cus_1', accountId: 1 });
      expect(subs.cancel).not.toHaveBeenCalled();
      expect(customers.del).toHaveBeenCalledWith('cus_1');
    },
  );

  it('tolerates already-gone objects', async () => {
    subs.retrieve.mockRejectedValue(missing());
    customers.del.mockRejectedValue(missing());
    await expect(teardownCustomer({ subId: 'sub_1', customerId: 'cus_1', accountId: 1 })).resolves.toBeUndefined();
  });

  it('skips null ids', async () => {
    await teardownCustomer({ subId: null, customerId: null, accountId: 1 });
    expect(subs.retrieve).not.toHaveBeenCalled();
    expect(customers.del).not.toHaveBeenCalled();
  });

  it('propagates other errors', async () => {
    customers.del.mockRejectedValue(new Error('stripe 500'));
    await expect(teardownCustomer({ subId: null, customerId: 'cus_1', accountId: 1 })).rejects.toThrow('stripe 500');
  });
});

describe('cancelAndRefundUnused', () => {
  // Invoices by id, for invoices.retrieve.
  function invoicesById(byId: Record<string, object>) {
    invoices.retrieve.mockImplementation((async (id: string) => ({ id, ...byId[id] })) as never);
  }

  // invoices.list by status: the paid ones (refund source) and the open ones (voided).
  function invoiceLists({ paid = [], open = [] }: { paid?: object[]; open?: object[] }) {
    invoices.list.mockImplementation((async ({ status }: { status: string }) => ({
      data: status === 'open' ? open.map((inv) => ({ status: 'open', ...inv })) : paid,
    })) as never);
  }

  // A live subscription whose current period (in_current) is paid; cancelling
  // leaves a 1200 credit on the final invoice, paid by pi_1.
  function paidSubscription() {
    subs.retrieve.mockResolvedValue({ status: 'active', latest_invoice: 'in_current', customer: 'cus_1' } as never);
    subs.cancel.mockResolvedValue({ status: 'canceled', latest_invoice: 'in_final', customer: 'cus_1' } as never);
    invoicesById({
      in_current: { status: 'paid', total: 3000, currency: 'usd' },
      in_final: { status: 'paid', total: -1200, currency: 'usd' },
    });
    invoiceLists({
      paid: [
        { id: 'in_final', amount_paid: 0 },
        { id: 'in_paid', amount_paid: 3000 },
      ],
    });
    invoicePayments.list.mockResolvedValue({
      data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_1' } }],
    } as never);
    refunds.list.mockResolvedValue({ data: [] } as never);
    customers.listBalanceTransactions.mockResolvedValue({ data: [] } as never);
  }

  const balanceCall = [
    'cus_1',
    {
      amount: 1200,
      currency: 'usd',
      description: 'Unused time refunded to the card',
      metadata: { vernal_displacement: 'sub_1' },
    },
    { idempotencyKey: 'displacement-balance-sub_1' },
  ];

  function refused(): Error {
    return new Stripe.errors.StripeInvalidRequestError({
      type: 'invalid_request_error',
      code: 'charge_disputed',
      message: 'Charge has been disputed',
      statusCode: 400,
    } as never);
  }

  it('cancels now with proration, refunds the credit to the last payment and zeroes the balance', async () => {
    paidSubscription();
    await cancelAndRefundUnused('sub_1', 7);
    expect(subs.cancel).toHaveBeenCalledWith('sub_1', { prorate: true, invoice_now: true });
    expect(invoices.list).toHaveBeenCalledWith({ subscription: 'sub_1', status: 'paid', limit: 10 });
    expect(invoicePayments.list).toHaveBeenCalledWith({ invoice: 'in_paid', status: 'paid', limit: 1 });
    expect(refunds.create).toHaveBeenCalledWith(
      {
        payment_intent: 'pi_1',
        amount: 1200,
        reason: 'requested_by_customer',
        metadata: { vernal_displacement: 'sub_1' },
      },
      { idempotencyKey: 'displacement-refund-sub_1' },
    );
    expect(customers.createBalanceTransaction).toHaveBeenCalledWith(...balanceCall);
    expect(invoices.voidInvoice).not.toHaveBeenCalled();
  });

  it.each(['past_due', 'unpaid'])(
    'a %s subscription is cancelled without proration, its open invoice voided, nothing refunded',
    async (status) => {
      paidSubscription();
      subs.retrieve.mockResolvedValue({ status, latest_invoice: 'in_current', customer: 'cus_1' } as never);
      invoicesById({ in_current: { status: 'open', total: 3000, currency: 'usd' } });
      invoiceLists({ open: [{ id: 'in_current' }] });
      await cancelAndRefundUnused('sub_1', 7);
      expect(subs.cancel).toHaveBeenCalledWith('sub_1', { prorate: false, invoice_now: false });
      expect(invoices.list).toHaveBeenCalledWith({ subscription: 'sub_1', status: 'open', limit: 100 });
      expect(invoices.voidInvoice).toHaveBeenCalledWith('in_current');
      expect(refunds.create).not.toHaveBeenCalled();
      expect(customers.createBalanceTransaction).not.toHaveBeenCalled();
    },
  );

  it('voids every open invoice of the cancelled subscription, not just the latest', async () => {
    subs.retrieve.mockResolvedValue({ status: 'past_due', latest_invoice: 'in_3', customer: 'cus_1' } as never);
    invoicesById({ in_3: { status: 'open', total: 3000, currency: 'usd' } });
    invoiceLists({ open: [{ id: 'in_1' }, { id: 'in_2' }, { id: 'in_3' }] });
    invoices.voidInvoice.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: 'no', statusCode: 400 } as never),
    );
    await cancelAndRefundUnused('sub_1', 7);
    expect(invoices.voidInvoice.mock.calls).toEqual([['in_1'], ['in_2'], ['in_3']]);
    // A refused void is logged for a manual fix; the rest still go through.
    expect(logger.error).toHaveBeenCalledWith(
      'Could not void the open invoice of a displaced subscription; void it by hand',
      expect.anything(),
      { accountId: 7, subId: 'sub_1', invoiceId: 'in_1' },
    );
  });

  it('an active subscription whose current invoice is still open is not refunded', async () => {
    paidSubscription();
    invoicesById({ in_current: { status: 'open', total: 3000, currency: 'usd' } });
    invoiceLists({ open: [{ id: 'in_current' }] });
    await cancelAndRefundUnused('sub_1', 7);
    expect(subs.cancel).toHaveBeenCalledWith('sub_1', { prorate: false, invoice_now: false });
    expect(invoices.voidInvoice).toHaveBeenCalledWith('in_current');
    expect(refunds.create).not.toHaveBeenCalled();
  });

  it('on a retry after an unpaid cancellation, voids the invoice still open and refunds nothing', async () => {
    subs.retrieve.mockResolvedValue({ status: 'canceled', latest_invoice: 'in_current', customer: 'cus_1' } as never);
    invoicesById({ in_current: { status: 'open', total: 3000, currency: 'usd' } });
    invoiceLists({ open: [{ id: 'in_current' }] });
    await cancelAndRefundUnused('sub_1', 7);
    expect(subs.cancel).not.toHaveBeenCalled();
    expect(invoices.voidInvoice).toHaveBeenCalledWith('in_current');
    expect(refunds.create).not.toHaveBeenCalled();
  });

  it('caps the refund at the last payment and reports the rest', async () => {
    paidSubscription();
    invoiceLists({ paid: [{ id: 'in_paid', amount_paid: 500 }] });
    await cancelAndRefundUnused('sub_1', 7);
    expect(refunds.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 500 }), expect.anything());
    expect(logger.error).toHaveBeenCalledWith(
      'Unused time exceeds the last payment; refund the rest by hand',
      undefined,
      expect.objectContaining({ accountId: 7, credit: 1200, refunded: 500 }),
    );
  });

  it('a subscription that had already ended with a credit is not refunded, only flagged for review', async () => {
    paidSubscription();
    // Ended before this call (an earlier attempt, or cancelled some other way).
    subs.retrieve.mockResolvedValue({ status: 'canceled', latest_invoice: 'in_final', customer: 'cus_1' } as never);
    await cancelAndRefundUnused('sub_1', 7);
    expect(subs.cancel).not.toHaveBeenCalled();
    expect(refunds.list).not.toHaveBeenCalled();
    expect(refunds.create).not.toHaveBeenCalled();
    expect(customers.listBalanceTransactions).not.toHaveBeenCalled();
    expect(customers.createBalanceTransaction).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Displaced subscription had already ended with a credit; review it by hand',
      undefined,
      { accountId: 7, subId: 'sub_1', credit: 1200 },
    );
  });

  it('a refund already made for this subscription is not made twice, and the balance is zeroed once', async () => {
    paidSubscription();
    refunds.list.mockResolvedValue({ data: [{ amount: 1200, metadata: { vernal_displacement: 'sub_1' } }] } as never);
    await cancelAndRefundUnused('sub_1', 7);
    expect(refunds.create).not.toHaveBeenCalled();
    expect(customers.createBalanceTransaction).toHaveBeenCalledWith(...balanceCall);

    customers.createBalanceTransaction.mockClear();
    customers.listBalanceTransactions.mockResolvedValue({
      data: [{ amount: 1200, metadata: { vernal_displacement: 'sub_1' } }],
    } as never);
    await cancelAndRefundUnused('sub_1', 7);
    expect(customers.createBalanceTransaction).not.toHaveBeenCalled();
  });

  it('refunds nothing when no unused time is credited', async () => {
    paidSubscription();
    invoicesById({
      in_current: { status: 'paid', total: 3000, currency: 'usd' },
      in_final: { status: 'paid', total: 0, currency: 'usd' },
    });
    await cancelAndRefundUnused('sub_1', 7);
    expect(subs.cancel).toHaveBeenCalledWith('sub_1', { prorate: true, invoice_now: true });
    expect(refunds.create).not.toHaveBeenCalled();
  });

  it('a subscription that ended some other way is left alone', async () => {
    subs.retrieve.mockResolvedValue({ status: 'canceled', latest_invoice: 'in_last', customer: 'cus_1' } as never);
    invoicesById({ in_last: { status: 'paid', total: 3000, currency: 'usd' } });
    invoiceLists({});
    await cancelAndRefundUnused('sub_1', 7);
    expect(subs.cancel).not.toHaveBeenCalled();
    expect(invoices.voidInvoice).not.toHaveBeenCalled();
    expect(refunds.create).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reports a credit with no payment to refund it to', async () => {
    paidSubscription();
    invoiceLists({ paid: [{ id: 'in_final', amount_paid: 0 }] });
    await cancelAndRefundUnused('sub_1', 7);
    expect(refunds.create).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'No payment found to refund unused time; refund it by hand',
      undefined,
      { accountId: 7, subId: 'sub_1', credit: 1200 },
    );
  });

  it('tolerates a subscription Stripe no longer has', async () => {
    subs.retrieve.mockRejectedValue(missing());
    await expect(cancelAndRefundUnused('sub_1', 7)).resolves.toBeUndefined();
    expect(refunds.create).not.toHaveBeenCalled();
  });

  it('a refund Stripe refuses (4xx) is logged with the amount for a manual refund, and the displacement goes on', async () => {
    paidSubscription();
    refunds.create.mockRejectedValue(refused());
    await expect(cancelAndRefundUnused('sub_1', 7)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'Stripe refused the unused-time refund; refund it by hand',
      expect.anything(),
      { accountId: 7, subId: 'sub_1', amount: 1200 },
    );
    // The credit stays on the balance until the manual refund.
    expect(customers.createBalanceTransaction).not.toHaveBeenCalled();
  });

  it('propagates network and 5xx errors from the refund', async () => {
    paidSubscription();
    refunds.create.mockRejectedValue(new Error('stripe 500'));
    await expect(cancelAndRefundUnused('sub_1', 7)).rejects.toThrow('stripe 500');
    refunds.create.mockRejectedValue(
      new Stripe.errors.StripeAPIError({ type: 'api_error', message: 'boom', statusCode: 500 } as never),
    );
    await expect(cancelAndRefundUnused('sub_1', 7)).rejects.toThrow('boom');
    refunds.create.mockRejectedValue(
      new Stripe.errors.StripeRateLimitError({ type: 'rate_limit_error', message: 'slow down', statusCode: 429 } as never),
    );
    await expect(cancelAndRefundUnused('sub_1', 7)).rejects.toThrow('slow down');
  });
});

describe('liveSubscriptionIds', () => {
  it("lists every subscription on the customer that hasn't ended", async () => {
    subs.list.mockResolvedValue({
      data: [
        { id: 'sub_1', status: 'active' },
        { id: 'sub_2', status: 'past_due' },
        { id: 'sub_3', status: 'canceled' },
        { id: 'sub_4', status: 'incomplete_expired' },
        { id: 'sub_5', status: 'trialing' },
      ],
    } as never);
    expect(await liveSubscriptionIds('cus_1', 7)).toEqual(['sub_1', 'sub_2', 'sub_5']);
    expect(subs.list).toHaveBeenCalledWith({ customer: 'cus_1', status: 'all', limit: 100 });
  });

  it('a customer Stripe no longer has has none; other errors propagate', async () => {
    subs.list.mockRejectedValueOnce(missing());
    expect(await liveSubscriptionIds('cus_1', 7)).toEqual([]);
    subs.list.mockRejectedValueOnce(new Error('network down'));
    await expect(liveSubscriptionIds('cus_1', 7)).rejects.toThrow('network down');
  });
});

describe('forgetCustomerContact', () => {
  it("clears the customer's email, name, phone, address and shipping, and leaves payment methods", async () => {
    await forgetCustomerContact('cus_1', 7);
    expect(customers.update).toHaveBeenCalledWith('cus_1', {
      email: '',
      name: '',
      phone: '',
      address: '',
      shipping: '',
    });
  });

  it('logs a failure instead of throwing', async () => {
    customers.update.mockRejectedValue(new Error('stripe 500'));
    await expect(forgetCustomerContact('cus_1', 7)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "Could not clear a displaced account's Stripe customer contact; clear it by hand",
      expect.anything(),
      { accountId: 7, customerId: 'cus_1' },
    );
  });
});

describe('expireOpenCheckoutSessions', () => {
  it("expires every open Checkout session on the customer", async () => {
    checkoutSessions.list.mockResolvedValue({ data: [{ id: 'cs_1' }, { id: 'cs_2' }] } as never);
    await expireOpenCheckoutSessions('cus_1', 7);
    expect(checkoutSessions.list).toHaveBeenCalledWith({ customer: 'cus_1', status: 'open', limit: 100 });
    expect(checkoutSessions.expire.mock.calls).toEqual([['cs_1'], ['cs_2']]);
  });

  it('logs failures instead of throwing, and carries on with the rest', async () => {
    checkoutSessions.list.mockResolvedValue({ data: [{ id: 'cs_1' }, { id: 'cs_2' }] } as never);
    checkoutSessions.expire.mockRejectedValueOnce(new Error('stripe 500'));
    await expect(expireOpenCheckoutSessions('cus_1', 7)).resolves.toBeUndefined();
    expect(checkoutSessions.expire).toHaveBeenCalledWith('cs_2');
    expect(logger.error).toHaveBeenCalledWith(
      "Could not expire a displaced account's open Checkout session; expire it by hand",
      expect.anything(),
      { accountId: 7, customerId: 'cus_1', sessionId: 'cs_1' },
    );

    vi.mocked(logger.error).mockClear();
    checkoutSessions.list.mockRejectedValue(new Error('network down'));
    await expect(expireOpenCheckoutSessions('cus_1', 7)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "Could not list a displaced account's open Checkout sessions; expire them by hand",
      expect.anything(),
      { accountId: 7, customerId: 'cus_1' },
    );
  });
});

describe('without a Stripe key', () => {
  beforeEach(() => {
    stripeState.configured = false;
  });

  it('stopRenewal skips and warns with the account id', async () => {
    await stopRenewal('sub_1', 42);
    expect(subs.retrieve).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Stripe not configured: billing step skipped', {
      action: 'stopRenewal',
      accountId: 42,
    });
  });

  it('resumeRenewal skips and warns', async () => {
    await resumeRenewal('sub_1', 42);
    expect(subs.retrieve).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Stripe not configured: billing step skipped', {
      action: 'resumeRenewal',
      accountId: 42,
    });
  });

  it('teardownCustomer skips and warns', async () => {
    await teardownCustomer({ subId: 'sub_1', customerId: 'cus_1', accountId: 42 });
    expect(subs.cancel).not.toHaveBeenCalled();
    expect(customers.del).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Stripe not configured: billing step skipped', {
      action: 'teardownCustomer',
      accountId: 42,
    });
  });

  it('cancelAndRefundUnused skips and warns', async () => {
    await cancelAndRefundUnused('sub_1', 42);
    expect(subs.retrieve).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Stripe not configured: billing step skipped', {
      action: 'cancelAndRefundUnused',
      accountId: 42,
    });
  });

  it('liveSubscriptionIds and forgetCustomerContact skip', async () => {
    expect(await liveSubscriptionIds('cus_1', 42)).toEqual([]);
    await forgetCustomerContact('cus_1', 42);
    expect(subs.list).not.toHaveBeenCalled();
    expect(customers.update).not.toHaveBeenCalled();
  });

  it('teardownCustomer with nothing to tear down does not warn', async () => {
    await teardownCustomer({ subId: null, customerId: null, accountId: 42 });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
