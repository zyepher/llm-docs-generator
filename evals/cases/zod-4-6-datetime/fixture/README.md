# room-bookings

Booking API for the meeting rooms. Requests from the web calendar and the mobile app are
validated with zod before they reach the scheduler.

- `src/rooms.ts`: the rooms that can be booked.

```sh
npm test          # vitest
npx tsc --noEmit  # type check
```
