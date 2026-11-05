export interface Item {
  id: number;
  name: string;
  priceCents: number;
}

export const ITEMS: readonly Item[] = [
  { id: 1, name: 'Espresso Cup', priceCents: 1200 },
  { id: 2, name: 'Pour Over Kettle', priceCents: 4900 },
  { id: 3, name: 'Ceramic Dripper', priceCents: 2500 },
  { id: 4, name: 'Travel Cup Lid', priceCents: 600 },
];
