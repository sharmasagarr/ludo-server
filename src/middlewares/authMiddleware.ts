import jwt from "jsonwebtoken";
import prisma from "../config/prisma.js";
import { Response, NextFunction } from "express";
import { AuthRequest, AuthenticatedUser } from "../types/index.js";

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
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { is_active: true, is_deleted: true }
    });

    if (!user || user.is_deleted || user.is_active === false) {
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
