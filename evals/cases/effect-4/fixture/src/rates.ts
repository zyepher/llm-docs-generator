/** An exchange rate as shown at checkout, and where it came from. */
export interface RateQuote {
  rate: number;
  source: 'live' | 'cache';
}

export function formatQuote(quote: RateQuote): string {
  const suffix = quote.source === 'cache' ? ' (cached)' : '';
  return `${quote.rate.toFixed(4)}${suffix}`;
}
