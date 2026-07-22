import db from "../config/db.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

export const loginUser = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: "User ID and password are required" });
  }

  try {
    const [rows] = await db.query(
      `SELECT * FROM users WHERE username = ?`,
      [username]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const foundUser = rows[0];

    // Verify bcrypt password
    const isMatch = await bcrypt.compare(password, foundUser.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid password" });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        id: foundUser.id,
        role: foundUser.role,
      },
      process.env.JWT_SECRET || "supersecretkey",
      { expiresIn: "7d" }
    );

    // Fetch active board if the player is currently in one
    const fetchActiveBoardForPlayer = async player_id => {
      try {
        const [boardRows] = await db.execute(
          `SELECT id FROM boards 
           WHERE status = 'active' 
             AND (player1 = ? OR player2 = ? OR player3 = ? OR player4 = ?)
           ORDER BY start_time DESC, id DESC
           LIMIT 1`,
          [player_id, player_id, player_id, player_id]
        );

        if (boardRows.length > 0) {
          const board = boardRows[0];
          const [colorRows] = await db.execute(
            `SELECT color FROM pawns 
             WHERE board_id = ? AND player_id = ? 
             LIMIT 1`,
            [board.id, player_id]
          );

          return {
            board_id: board.id,
            myColor: colorRows.length > 0 ? colorRows[0].color : null,
          };
        }
      } catch (boardError) {
        console.error("Error fetching current board:", boardError);
      }
      return null;
    };

    const currentBoard = await fetchActiveBoardForPlayer(foundUser.id);

    res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: foundUser.id,
        username: foundUser.username,
        name: foundUser.name,
        role: foundUser.role
      },
      ...(currentBoard ? { currentBoard: currentBoard } : {}),
    });
    
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
};

export const signupUser = async (req, res) => {
  const { username, name, password } = req.body;
  if (!username || !password || !name) {
    return res.status(400).json({ message: "Username, Name, and Password are required" });
  }

  try {
    const [existing] = await db.query(`SELECT id FROM users WHERE username = ?`, [username]);
    if (existing.length > 0) {
      return res.status(409).json({ message: "Username already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      `INSERT INTO users (username, name, password, role) VALUES (?, ?, ?, 'user')`,
      [username, name, hashedPassword]
    );

    res.status(201).json({ message: "User registered successfully", id: result.insertId });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
};
