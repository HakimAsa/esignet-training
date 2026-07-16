import { Router } from "express";
import { authController } from "../controllers/auth.controller.js";

export const authRouter = Router();

authRouter.get("/esignet/prepare", authController.prepareEsignetLogin);
authRouter.get("/esignet/logout", authController.logoutEsignet);
