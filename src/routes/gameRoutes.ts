import express, { Router } from "express";
import { createGame, joinGame } from "../controllers/gameControllers.js";
import { authenticateUser } from "../middlewares/authMiddleware.js";

const router: Router = express.Router();

router.post("/createGame", authenticateUser, createGame);
router.post("/joinGame", authenticateUser, joinGame);

export default router;
