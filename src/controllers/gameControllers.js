import db from "../config/db.js";
import { v7 as uuidv7 } from "uuid";

// Default colors for joining players (Blue first, opposite is Green, then Red, Yellow)
const PLAYER_COLORS = ["blue", "green", "red", "yellow"];

// Initialize 4 pawns for a player entering the game
const initializePawns = async (board_id, player_id, color) => {
  const pawnValues = Array.from({ length: 4 }).map(() => [
    uuidv7(),
    board_id,
    player_id,
    "base", // Starting inside the base
    color,
    null,
    null,
    1, // is_safe
  ]);
  
  await db.query(
    `INSERT INTO pawns (id, board_id, player_id, type, color, current_position, next_position, is_safe) VALUES ?`, 
    [pawnValues]
  );
};

export const createGame = async (req, res) => {
  // Use authenticated user ID instead of accepting untrusted username from body
  const player_id = req.user.id;
  if (!player_id) {
    return res.status(400).json({ message: "User not authenticated." });
  }

  try {
    const board_id = uuidv7();
    
    // Create new board
    await db.query(
      `INSERT INTO boards (id, player1, creator, creation_mode, status) VALUES (?, ?, ?, 'manual', 'active')`,
      [board_id, player_id, player_id]
    );

    // Initialize pawns for Player 1 (Red by default)
    await initializePawns(board_id, player_id, PLAYER_COLORS[0]);

    res.status(200).json({
      success: true,
      message: "Game created successfully",
      board_id,
    });
  } catch (error) {
    console.error("Error creating game:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

export const joinGame = async (req, res) => {
  const { board_id } = req.body;
  const player_id = req.user.id;
  
  if (!player_id || !board_id) {
    return res.status(400).json({ message: "Authenticated user and board_id are required" });
  }

  try {
    const [boards] = await db.query(`SELECT * FROM boards WHERE id = ?`, [board_id]);
    if (boards.length === 0) {
      return res.status(404).json({ success: false, message: "Board not found" });
    }

    const board = boards[0];

    if (board.status !== 'active') {
       return res.status(400).json({ success: false, message: "Game is not active" });
    }

    // Check if player is already in the game
    if (board.player1 === player_id || board.player2 === player_id || board.player3 === player_id || board.player4 === player_id) {
      return res.status(200).json({ success: true, message: "Already joined", board_id });
    }

    // Find first available slot
    let slotToFill = null;
    let colorIndex = 0;
    if (!board.player2) { slotToFill = 'player2'; colorIndex = 1; }
    else if (!board.player3) { slotToFill = 'player3'; colorIndex = 2; }
    else if (!board.player4) { slotToFill = 'player4'; colorIndex = 3; }

    if (!slotToFill) {
      return res.status(400).json({ success: false, message: "Game is already full (4 players max)" });
    }

    await db.query(`UPDATE boards SET ${slotToFill} = ? WHERE id = ?`, [player_id, board_id]);
    await initializePawns(board_id, player_id, PLAYER_COLORS[colorIndex]);

    res.status(200).json({
      success: true,
      message: "Joined game successfully",
      board_id
    });
    
  } catch (error) {
    console.error("Error joining game:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};
