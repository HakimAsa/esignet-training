import { prisma } from "../lib/prisma.js";
import { AppError } from "../middleware/error-handler.js";
import type { CreateUserInput } from "../schemas/user.schema.js";

export const userService = {
  list() {
    return prisma.user.findMany({ orderBy: { createdAt: "desc" } });
  },

  async getById(id: string) {
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new AppError(404, `User ${id} not found`);
    return user;
  },

  async create(input: CreateUserInput) {
    try {
      return await prisma.user.create({ data: { email: input.email, name: input.name ?? null } });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new AppError(409, `User with email ${input.email} already exists`);
      }
      throw err;
    }
  },
};

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
}
