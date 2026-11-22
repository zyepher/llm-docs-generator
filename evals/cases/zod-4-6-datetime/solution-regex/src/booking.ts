import * as z from 'zod';

import { ROOM_IDS } from './rooms.js';

// Also correct: the task does not require zod's own datetime format, so a pattern that accepts
// exactly the three UTC forms is a legitimate answer and must pass.
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

export const bookingSchema = z.object({
  roomId: z.enum(ROOM_IDS),
  startsAt: z.string().regex(UTC_TIMESTAMP),
});

export type Booking = z.infer<typeof bookingSchema>;
