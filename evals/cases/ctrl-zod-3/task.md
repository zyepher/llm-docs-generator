Add a `src/signup.ts` module that validates the signup form with zod. It should export:

1. `signupSchema`: an object schema with `username` (3 to 20 characters), `email` (a valid email address), `password` (at least 8 characters), and `confirmPassword`. When `confirmPassword` differs from `password`, validation fails with the message `Passwords do not match` reported on the `confirmPassword` field.
2. `SignupInput`: the TypeScript type inferred from `signupSchema`.
3. `validateSignup(input: unknown)`: returns `{ ok: true, data }` with the parsed `SignupInput` when the input is valid, and `{ ok: false, fieldErrors }` otherwise, where `fieldErrors` maps each failing field name to its list of error messages (for example `{ confirmPassword: ['Passwords do not match'] }`). It must never throw.

Keep it fully typed: no `any` casts or ts-ignore comments. Do not change package.json or install packages. Run the type checker when you are done.
