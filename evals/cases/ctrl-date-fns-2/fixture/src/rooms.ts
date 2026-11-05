export type RoomType = 'single' | 'double' | 'suite';

export interface Room {
  id: string;
  type: RoomType;
  nightlyRateCents: number;
}

export const ROOMS: readonly Room[] = [
  { id: '101', type: 'single', nightlyRateCents: 8900 },
  { id: '204', type: 'double', nightlyRateCents: 12900 },
  { id: '501', type: 'suite', nightlyRateCents: 24900 },
];
