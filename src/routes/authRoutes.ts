import express, { Router } from "express";
import { loginUser, signupUser } from "../controllers/authControllers.js";

const router: Router = express.Router();

router.post("/login", loginUser);
router.post("/signup", signupUser);

export default router;
