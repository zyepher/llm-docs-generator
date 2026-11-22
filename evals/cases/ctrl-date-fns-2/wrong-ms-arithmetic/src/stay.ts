import { addDays, format, startOfDay } from 'date-fns';

const GUEST_FORMAT = 'EEE, d MMM yyyy';
const DAY_MS = 24 * 60 * 60 * 1000;

// Wrong: counts nights as whole 24-hour spans, so a stay across the switch to summer time (a
// 23-hour day) loses a night. It passed on a grading host in UTC and failed on one in Europe;
// with the time zone pinned it fails everywhere.
export function formatStayRange(checkIn: Date, nights: number): string {
  const checkOut = addDays(checkIn, nights);
  return `${format(checkIn, GUEST_FORMAT)} to ${format(checkOut, GUEST_FORMAT)}`;
}

export function nightsBetween(checkIn: Date, checkOut: Date): number {
  return Math.floor((startOfDay(checkOut).getTime() - startOfDay(checkIn).getTime()) / DAY_MS);
}
