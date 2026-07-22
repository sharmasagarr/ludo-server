import dotenv from "dotenv";
import db from "./src/config/db.js";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import authRoutes from "./src/routes/authRoutes.js";
import gameRoutes from "./src/routes/gameRoutes.js";
import gameSocket from "./src/sockets/gameSocket.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
dotenv.config();
app.use(express.json());
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true,
  },
});

gameSocket(io);

const PORT = process.env.PORT || 4500;

app.get("/", (_req, res) => {
  res.send("Ludo-Backend is running...");
});

// Configure body parsing - skip for multipart/form-data (handled by multer)
app.use((req, res, next) => {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
    // Skip body parsing for multipart - let multer handle it
    return next();
  }
  // Parse JSON and URL-encoded bodies
  express.json()(req, res, () => {
    express.urlencoded({ extended: true })(req, res, next);
  });
});

// Serve static files (prescription images)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use("/api/auth", authRoutes);
app.use("/api/game", gameRoutes);

try {
  // Just test once
  const [rows] = await db.execute("SELECT NOW() AS currentTime");
  console.info("✅ MySQL connected | ⏰ DB Time:", rows[0].currentTime);

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.info(`🚀 Server running at http://localhost:${PORT}`);
  });
} catch (err) {
  console.error("❌ MYSQL DB connection error:", err.message);
  process.exit(1);
}
 