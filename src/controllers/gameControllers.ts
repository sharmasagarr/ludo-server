import prisma from "../config/prisma.js";
import { v7 as uuidv7 } from "uuid";
import { Response } from "express";
import { AuthRequest } from "../types/index.js";

// Default colors for joining players (Blue first, opposite is Green, then Red, Yellow)
const PLAYER_COLORS = ["blue", "green", "red", "yellow"];

const initializePawns = async (board_id: string, player_id: string, color: "red"|"blue"|"green"|"yellow"): Promise<void> => {
  const pawnData = Array.from({ length: 4 }).map(() => ({
    board_id,
    player_id,
    type: "base" as const,
    color,
    is_safe: true,
  }));
  
  await prisma.pawn.createMany({
    data: pawnData
  });
};

export const createGame = async (req: AuthRequest, res: Response): Promise<void> => {
  // Use authenticated user ID instead of accepting untrusted username from body
  const player_id = req.user?.id;
  if (!player_id) {
    res.status(400).json({ message: "User not authenticated." });
    return;
  }

  try {
    const board = await prisma.board.create({
      data: {
        player1: player_id,
        creator: player_id,
        creation_mode: "manual",
        status: "active"
      }
    });

    const board_id = board.id;

    // Initialize pawns for Player 1 (Red by default)
    await initializePawns(board_id, player_id, PLAYER_COLORS[0] as "red"|"blue"|"green"|"yellow");

    res.status(200).json({
      success: true,
      message: "Game created successfully",
      board_id,
    });
  } catch (error: unknown) {
    console.error("Error creating game:", error);
    res.status(500).json({ success: false, message: "Server error", error: error instanceof Error ? error.message : String(error) });
  }
};

export const joinGame = async (req: AuthRequest, res: Response): Promise<void> => {
  const { board_id } = req.body;
  const player_id = req.user?.id;
  
  if (!player_id || !board_id) {
    res.status(400).json({ message: "Authenticated user and board_id are required" });
    return;
  }

  try {
    const board = await prisma.board.findUnique({ where: { id: board_id } });
    if (!board) {
      res.status(404).json({ success: false, message: "Board not found" });
      return;
    }

    if (board.status !== 'active') {
       res.status(400).json({ success: false, message: "Game is not active" });
       return;
    }

    // Check if player is already in the game
    if (board.player1 === player_id || board.player2 === player_id || board.player3 === player_id || board.player4 === player_id) {
      res.status(200).json({ success: true, message: "Already joined", board_id });
      return;
    }

    // Find first available slot
    let slotToFill = null;
    let colorIndex = 0;
    if (!board.player2) { slotToFill = 'player2'; colorIndex = 1; }
    else if (!board.player3) { slotToFill = 'player3'; colorIndex = 2; }
    else if (!board.player4) { slotToFill = 'player4'; colorIndex = 3; }

    if (!slotToFill) {
      res.status(400).json({ success: false, message: "Game is already full (4 players max)" });
      return;
    }

    await prisma.board.update({
      where: { id: board_id },
      data: { [slotToFill]: player_id }
    });

    await initializePawns(board_id, player_id, PLAYER_COLORS[colorIndex] as "red"|"blue"|"green"|"yellow");

    res.status(200).json({
      success: true,
      message: "Joined game successfully",
      board_id
    });
    
  } catch (error: unknown) {
    console.error("Error joining game:", error);
    res.status(500).json({ success: false, message: "Server error", error: error instanceof Error ? error.message : String(error) });
  }
};
