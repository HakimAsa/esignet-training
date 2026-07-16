import { Router } from "express";
import { userController } from "../controllers/user.controller.js";
import { validate } from "../middleware/validate.js";
import { createUserSchema, userParamsSchema } from "../schemas/user.schema.js";

export const userRouter = Router();

userRouter.get("/", userController.list);
userRouter.get("/:id", validate({ params: userParamsSchema }), userController.getById);
userRouter.post("/", validate({ body: createUserSchema }), userController.create);
