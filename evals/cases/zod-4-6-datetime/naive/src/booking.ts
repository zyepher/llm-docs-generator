import * as z from 'zod';

import { ROOM_IDS } from './rooms.js';

// Written from zod 4.4 knowledge, where the ISO datetime format accepted minute precision.
export const bookingSchema = z.object({
  roomId: z.enum(ROOM_IDS),
  startsAt: z.iso.datetime(),
});

export type Booking = z.infer<typeof bookingSchema>;
