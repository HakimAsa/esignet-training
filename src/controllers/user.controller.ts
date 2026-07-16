import type { NextFunction, Request, Response } from "express";
import { userService } from "../services/user.service.js";

export const userController = {
  async list(_req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await userService.list());
    } catch (err) {
      next(err);
    }
  },

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      res.json(await userService.getById(req.params.id as string));
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await userService.create(req.body);
      res.status(201).json(user);
    } catch (err) {
      next(err);
    }
  },
};
