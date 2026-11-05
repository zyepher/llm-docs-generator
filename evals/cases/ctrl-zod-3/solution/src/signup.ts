import { z } from 'zod';

export const signupSchema = z
  .object({
    username: z.string().min(3).max(20),
    email: z.string().email(),
    password: z.string().min(8),
    confirmPassword: z.string(),
  })
  .refine((form) => form.confirmPassword === form.password, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export type SignupInput = z.infer<typeof signupSchema>;

export type SignupResult =
  | { ok: true; data: SignupInput }
  | { ok: false; fieldErrors: Partial<Record<keyof SignupInput, string[]>> };

export function validateSignup(input: unknown): SignupResult {
  const result = signupSchema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, fieldErrors: result.error.flatten().fieldErrors };
}
