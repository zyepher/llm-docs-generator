# signup-service

Backend for the account signup form. Form posts are validated with zod and field errors are
sent back to the browser so the form can show them next to each input.

- `src/users.ts`: the user record we store after signup.

```sh
npm test          # vitest
npx tsc --noEmit  # type check
```
