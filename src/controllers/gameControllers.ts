import prisma from "../config/prisma.js";
import { Color } from "@prisma/client";
import { Response } from "express";
import { AuthRequest } from "../types/index.js";

const PLAYER_COLORS = ['red', 'green', 'yellow', 'blue', 'orange', 'pink'];

// Default colors for joining players (Blue first, opposite is Green, then Red, Yellow)
const initializePawns = async (board_player_id: string): Promise<void> => {
  const pawnData = Array.from({ length: 4 }).map(() => ({
    board_player_id,
    cell_type: "base" as const,
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
        creator: player_id,
        creation_mode: "manual",
        status: "active",
        players: {
          create: { 
            user_id: player_id, 
            seat_number: 1,
            color: PLAYER_COLORS[0] as Color
          }
        }
      },
      include: { players: true }
    });

    const board_id = board.id;
    const board_player_id = board.players[0].id;

    // Initialize pawns
    await initializePawns(board_player_id);

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

    const boardPlayers = await prisma.boardPlayer.findMany({ where: { board_id } });

    // Check if player is already in the game
    if (boardPlayers.some(p => p.user_id === player_id)) {
      res.status(200).json({ success: true, message: "Already joined", board_id });
      return;
    }

    // Find first available slot
    const usedSeats = boardPlayers.map(p => p.seat_number).filter(Boolean) as number[];
    let seatToFill = 1;
    while(usedSeats.includes(seatToFill)) { seatToFill++; }

    if (seatToFill > 4) {
      res.status(400).json({ success: false, message: "Game is already full (4 players max)" });
      return;
    }

    const bp = await prisma.boardPlayer.create({
      data: { 
        board_id: board_id,
        user_id: player_id,
        seat_number: seatToFill,
        color: PLAYER_COLORS[seatToFill - 1] as Color
      }
    });

    await initializePawns(bp.id);

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
