import { z } from "zod";

// eSignet redirects here either with {code, state} on success, or with
// {error, error_description, state?} if the user denied consent / auth failed.
export const callbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  error_description: z.string().optional(),
});
