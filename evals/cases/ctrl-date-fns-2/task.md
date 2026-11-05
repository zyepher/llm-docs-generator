Add a `src/stay.ts` module to this project with two exported functions, using date-fns for the date math:

1. `formatStayRange(checkIn: Date, nights: number): string` returns the stay as shown to guests: the check-in day, the word `to`, and the check-out day (check-in plus `nights` days), each formatted as short weekday, day of month without padding, short month name, and four-digit year. For example a 3 night stay from 3 March 2025 is `Mon, 3 Mar 2025 to Thu, 6 Mar 2025`.
2. `nightsBetween(checkIn: Date, checkOut: Date): number` returns the number of nights billed: the number of calendar days between the two dates, ignoring the time of day. A check-in at 23:00 and a check-out at 01:00 the next morning is 1 night.

Keep it fully typed: no `any` casts or ts-ignore comments. Do not change package.json or install packages. Run the type checker when you are done.
