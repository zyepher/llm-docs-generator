import { addDays, differenceInCalendarDays, format } from 'date-fns';

const GUEST_FORMAT = 'EEE, d MMM yyyy';

export function formatStayRange(checkIn: Date, nights: number): string {
  const checkOut = addDays(checkIn, nights);
  return `${format(checkIn, GUEST_FORMAT)} to ${format(checkOut, GUEST_FORMAT)}`;
}

export function nightsBetween(checkIn: Date, checkOut: Date): number {
  return differenceInCalendarDays(checkOut, checkIn);
}
