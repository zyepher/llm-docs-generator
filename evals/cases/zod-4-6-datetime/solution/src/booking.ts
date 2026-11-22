import * as z from 'zod';

import { ROOM_IDS } from './rooms.js';

// Since zod 4.5 the ISO datetime format requires seconds by default; precision -1 is the
// minute-only form, so the union accepts both.
const utcTimestamp = z.union([z.iso.datetime(), z.iso.datetime({ precision: -1 })]);

export const bookingSchema = z.object({
  roomId: z.enum(ROOM_IDS),
  startsAt: utcTimestamp,
});

export type Booking = z.infer<typeof bookingSchema>;
