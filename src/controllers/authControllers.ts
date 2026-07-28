import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import db from "../config/db.js";
import { v7 as uuidv7 } from "uuid";
import { Request, Response } from "express";
import { RowDataPacket, ResultSetHeader } from "mysql2/promise";

const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";

export const signupUser = async (req: Request, res: Response): Promise<void> => {
  const { username, name, password } = req.body;

  if (!username || !name || !password) {
    res.status(400).json({ message: "All fields are required" });
    return;
  }

  try {
    const [existing] = await db.query<RowDataPacket[]>("SELECT id FROM users WHERE username = ?", [username]);
    if (existing.length > 0) {
      res.status(409).json({ message: "Username already exists" });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv7();

    const [result] = await db.query<ResultSetHeader>(
      "INSERT INTO users (id, username, name, password, role) VALUES (?, ?, ?, ?, 'user')",
      [userId, username, name, hashedPassword]
    );

    res.status(201).json({ message: "User registered successfully", id: userId });
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
    const [users] = await db.query<RowDataPacket[]>("SELECT * FROM users WHERE username = ?", [username]);

    if (users.length === 0) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      res.status(400).json({ message: "Invalid credentials" });
      return;
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, {
      expiresIn: "7d",
    });

    const [activeBoards] = await db.query<RowDataPacket[]>(
      `SELECT id as board_id, creator FROM boards 
       WHERE status = 'active'
       AND (player1 = ? OR player2 = ? OR player3 = ? OR player4 = ?)`,
      [user.id, user.id, user.id, user.id]
    );

    const currentBoard = activeBoards.length > 0 ? activeBoards[0] : null;

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
