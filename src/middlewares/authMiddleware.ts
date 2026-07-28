import jwt from "jsonwebtoken";
import db from "../config/db.js";
import { Response, NextFunction } from "express";
import { AuthRequest, AuthenticatedUser } from "../types/index.js";
import { RowDataPacket } from "mysql2/promise";

export const authenticateUser = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "supersecretkey") as AuthenticatedUser;
    
    // Check if user is deleted or inactive
    const [users] = await db.query<RowDataPacket[]>(
      `SELECT status, is_deleted FROM users WHERE id = ?`,
      [decoded.id]
    );

    if (users.length === 0 || users[0].is_deleted || users[0].status === 0) {
      res.status(403).json({ message: "Account disabled or deleted." });
      return;
    }

    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ message: "Invalid or expired token" });
    return;
  }
};
