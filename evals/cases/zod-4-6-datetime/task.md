Add a `src/booking.ts` module that validates room booking requests with zod. It should export:

1. `bookingSchema`: an object schema for `{ roomId, startsAt }`. `roomId` is one of the rooms in `src/rooms.ts`. `startsAt` is the start time as a UTC timestamp string, kept exactly as it was sent. Our web calendar sends start times to the minute, like `2026-12-01T09:30Z`; the mobile app sends milliseconds, like `2026-12-01T09:30:00.000Z`; other clients send whole seconds, like `2026-12-01T09:30:00Z`. Accept all of these. Reject anything that is not a UTC timestamp: no trailing `Z`, a numeric offset such as `+01:00`, a date without a time, or free text.
2. `Booking`: the TypeScript type inferred from `bookingSchema`.

Keep it fully typed: no `any` casts or ts-ignore comments. Do not change package.json or install packages. Run the type checker when you are done.
