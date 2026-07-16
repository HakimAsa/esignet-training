import { z } from "zod";

export const createUserSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(120).optional(),
});

export const userParamsSchema = z.object({
  id: z.uuid(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
