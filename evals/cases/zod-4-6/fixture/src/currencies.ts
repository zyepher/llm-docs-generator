export const PAYOUT_CURRENCIES = ['EUR', 'GBP', 'CHF'] as const;

export type PayoutCurrency = (typeof PAYOUT_CURRENCIES)[number];
