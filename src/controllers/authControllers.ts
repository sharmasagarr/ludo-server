import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../config/prisma.js";
import { Request, Response } from "express";

const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";

export const signupUser = async (req: Request, res: Response): Promise<void> => {
  const { username, name, password } = req.body;

  if (!username || !name || !password) {
    res.status(400).json({ message: "All fields are required" });
    return;
  }

  try {
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      res.status(409).json({ message: "Username already exists" });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    const user = await prisma.user.create({
      data: {
        username,
        name,
        password: hashedPassword,
        role: "user"
      }
    });

    res.status(201).json({ message: "User registered successfully", id: user.id });
  } catch (error: unknown) {
    console.error("Signup error:", error);
    res.status(500).json({ message: "Internal Server Error", error: error instanceof Error ? error.message : String(error) });
  }
};

export const loginUser = async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ message: "Username and password are required" });
    return;
  }

  try {
    const user = await prisma.user.findUnique({ where: { username } });

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      res.status(400).json({ message: "Invalid credentials" });
      return;
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, {
      expiresIn: "7d",
    });

    const activeBoard = await prisma.board.findFirst({
      where: {
        status: "active",
        OR: [
          { player1: user.id },
          { player2: user.id },
          { player3: user.id },
          { player4: user.id }
        ]
      },
      select: {
        id: true,
        creator: true
      }
    });

    const currentBoard = activeBoard ? { board_id: activeBoard.id, creator: activeBoard.creator } : null;

    res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: { id: user.id, username: user.username, name: user.name, role: user.role, points: user.points },
      currentBoard
    });
  } catch (error: unknown) {
    console.error("Login Error:", error);
    res.status(500).json({ message: "Internal Server Error", error: error instanceof Error ? error.message : String(error) });
  }
};
