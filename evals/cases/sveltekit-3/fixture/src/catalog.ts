export interface Product {
  sku: string;
  name: string;
  priceCents: number;
}

export const PRODUCTS: readonly Product[] = [
  { sku: 'mug-01', name: 'Enamel mug', priceCents: 1800 },
  { sku: 'tote-02', name: 'Canvas tote', priceCents: 2400 },
];

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
