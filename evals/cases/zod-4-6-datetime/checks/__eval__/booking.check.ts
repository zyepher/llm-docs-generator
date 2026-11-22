import { describe, expect, expectTypeOf, it } from 'vitest';

import { type Booking, bookingSchema } from '../src/booking.js';

expectTypeOf<Booking>().toEqualTypeOf<{
  roomId: 'atrium' | 'boardroom' | 'studio';
  startsAt: string;
}>();

const accepts = (startsAt: string): boolean =>
  bookingSchema.safeParse({ roomId: 'atrium', startsAt }).success;

describe('bookingSchema', () => {
  it('accepts UTC start times to the minute, the second, and the millisecond', () => {
    for (const startsAt of [
      '2026-12-01T09:30Z',
      '2026-12-01T09:30:00Z',
      '2026-12-01T09:30:00.000Z',
      '2027-02-28T23:59Z',
    ]) {
      expect(accepts(startsAt), startsAt).toBe(true);
    }
  });

  it('keeps the start time exactly as it was sent', () => {
    expect(bookingSchema.parse({ roomId: 'studio', startsAt: '2026-12-01T09:30Z' })).toEqual({
      roomId: 'studio',
      startsAt: '2026-12-01T09:30Z',
    });
  });

  it('rejects anything that is not a UTC timestamp', () => {
    for (const startsAt of [
      '2026-12-01T09:30',
      '2026-12-01T09:30:00',
      '2026-12-01T09:30+01:00',
      '2026-12-01T09:30:00+01:00',
      '2026-12-01',
      'tomorrow at 9',
      '',
    ]) {
      expect(accepts(startsAt), startsAt).toBe(false);
    }
  });

  it('rejects unknown rooms and missing fields', () => {
    expect(bookingSchema.safeParse({ roomId: 'cellar', startsAt: '2026-12-01T09:30Z' }).success).toBe(
      false
    );
    expect(bookingSchema.safeParse({ roomId: 'atrium' }).success).toBe(false);
    expect(bookingSchema.safeParse(null).success).toBe(false);
  });
});
