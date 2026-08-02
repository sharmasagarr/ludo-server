import prisma from "../config/prisma.js";
import { Prisma, CellType } from "@prisma/client";
import { canPlayerAct, recomputeTurnStateForBoard, advanceTurnAfterMove, startTurnTimer } from "./turnState.js"; 
import handleFinalPos from "../utils/handleFinalPos.js";
import { mapPawnToClient } from "../utils/positionMapper.js";
import { Server } from "socket.io";
import { GameSocket } from "../types/index.js";

export const rollDice = async (
  io: Server, 
  socket: GameSocket, 
  payload: { board_id: string; player_id: string; [key: string]: unknown }, 
  ack: (response?: unknown) => void
) => {
  const safeAck = (x: unknown) => { try { ack?.(x); } catch {} };

  try {
    const { board_id, player_id } = payload ?? {};

    // 🎲 Securely generate dice roll on the backend (1-6)
    const dice_value = Math.floor(Math.random() * 6) + 1;

    // Basic validation
    if (!board_id || !player_id) {
      return safeAck({ ok: false, msg: "Missing required fields: board_id or player_id" });
    }

    if (socket.board_id !== board_id || socket.player_id !== player_id) {
      return safeAck({ ok: false, msg: "Invalid player or board" });
    }

    // 🔒 TURN & BALANCE CHECK
    const can = await canPlayerAct(io, board_id, player_id);
    if (!can.ok) {
      if (can.reason === "NO_BALANCE") {
        return safeAck({ ok: false, msg: "No dice balance left" });
      }
      if (can.reason === "NOT_YOUR_TURN") {
        return safeAck({ ok: false, msg: "Not your turn" });
      }
      if (can.reason === "WAITING_FOR_PLAYERS") {
        return safeAck({ ok: false, msg: "Waiting for more players to join" });
      }
      return safeAck({ ok: false, msg: "Cannot roll dice" });
    }

    // 🔒 PENDING DICE CHECK: Prevent re-rolling if they already have an unspent dice value
    const existingRolls = await prisma.boardPlayer.findUnique({
      where: { board_id_user_id: { board_id, user_id: player_id } }
    });
    
    if (existingRolls?.dice_value !== null && existingRolls?.dice_value !== undefined) {
      return safeAck({ ok: false, msg: "You must spend your active dice roll before rolling again." });
    }

    // Notify clients that player started rolling
    io.to(board_id).emit("playerStartedRolling", {
      board_id,
      player_id,
      timestamp: new Date().toISOString()
    });

    let valid_moves = false;
    let validPawnIds: string[] = [];
    let allPlayers: (import("@prisma/client").BoardPlayer & { user: { name: string } | null })[] = [];

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {


      // Determine valid_moves completely on the backend
      const bp = await tx.boardPlayer.findUnique({
        where: { board_id_user_id: { board_id, user_id: player_id } }
      });
      const playerPawnsRaw = bp ? await tx.pawn.findMany({
        where: { board_player_id: bp.id },
        include: { boardPlayer: true }
      }) : [];
      const playerPawns = playerPawnsRaw.map(mapPawnToClient);


    for (const pawn of playerPawns) {
      if (pawn.current_position === 'finished' || pawn.type === CellType.center) continue;
      const moveResult = handleFinalPos(pawn.current_position, dice_value, pawn.color as string, pawn.type as string);
      if (moveResult && !moveResult.error) {
        valid_moves = true;
        validPawnIds.push(pawn.id);
      }
    }

    // Store the roll in dice_rolls and dice_roll_logs
      await tx.boardPlayer.update({
        where: { board_id_user_id: { board_id, user_id: player_id } },
        data: { dice_value, rolled_at: new Date() }
      });
      
      if (bp) {
        await tx.diceRollLog.create({
          data: {
            board_player_id: bp.id,
            dice_value,
            valid_moves: valid_moves,
            rolled_at: new Date()
          }
        });
      }

      // Retrieve all players' dice for this board
      const diceRollsList = await tx.boardPlayer.findMany({
        where: { board_id },
        include: { user: { select: { name: true } } },
        orderBy: { rolled_at: 'desc' }
      });
      allPlayers = diceRollsList;
    });

    // Build base roll result
    const rollResult = {
      board_id,
      player_id,
      dice_value,
      isAllPawnsLocked: valid_moves === false, // for client animation timing
      allPlayersDice: allPlayers.map(p => ({
        player_id: p.user_id,
        playerName: p.user?.name,
        dice_value: p.dice_value,
        rolled_at: p.rolled_at,
        isDiceRolling: p.user_id === player_id // only rolling player has animation
      }))
    };

    // Ack the roller immediately
    safeAck({
      ok: true,
      msg: valid_moves ? "Dice rolled successfully" : "No valid moves available",
      ...rollResult
    });

    // Broadcast dice roll to EVERYONE ELSE (excluding the roller who got the ack)
    socket.to(board_id).emit("diceRolled", rollResult);
    
    // Only broadcast the mid-turn state update if valid moves exist.
    // If no valid moves exist, advanceTurnAfterMove will exclusively handle broadcasting the new turn.
    await recomputeTurnStateForBoard(io, board_id, valid_moves !== false);

    // Give the player a fresh 30 seconds to actually perform their move!
    if (valid_moves !== false) {
      startTurnTimer(io, board_id);
      
      // 🔥 QOL AUTO-MOVE: If they have EXACTLY 1 valid pawn, move it automatically
      // after a short 1.5s delay to allow the frontend dice rolling animation to finish!
      if (validPawnIds.length === 1) {
        const forcedPawnId = validPawnIds[0];
        console.log(`[QOL] Only 1 valid pawn found for ${player_id}. Auto-moving pawn ${forcedPawnId} in 1.5s.`);
        
        setTimeout(async () => {
          try {
            const { movePawn } = await import('./movePawn.js');
            const mockSocket = {
              id: 'SERVER_SINGLE_PAWN_AUTO',
              board_id: board_id,
              player_id: player_id,
              to: (room: string) => io.to(room),
              emit: () => {} 
            } as unknown as GameSocket;
            
            await movePawn(io, mockSocket, {
              board_id,
              pawn_id: forcedPawnId,
              player_id: player_id
            }, () => {});
          } catch(autoErr) {
            console.error("QOL Auto-move failed:", autoErr);
          }
        }, 1500); 
      }
    }

    // 🔥 AUTO-CLEAR DICE if no valid moves (merged diceClear logic)
    if (valid_moves === false) {
      console.log(`Auto-clearing dice for ${player_id} (no valid moves)`);
      
      // Clear the roller's dice_value in DB (same as old diceClear)
      await prisma.boardPlayer.update({
        where: { board_id_user_id: { board_id, user_id: player_id } },
        data: { dice_value: null, rolled_at: new Date() }
      });

      // Get updated dice state after clearing
      const updatedPlayers = await prisma.boardPlayer.findMany({
        where: { board_id },
        include: { user: { select: { name: true } } },
        orderBy: { rolled_at: 'desc' }
      });

      const clearResult = {
        board_id,
        player_id,
        dice_value: null,
        allPlayersDice: updatedPlayers.map((p) => ({
          player_id: p.user_id,
          playerName: p.user?.name,
          dice_value: p.dice_value,
          rolled_at: p.rolled_at
        }))
      };

      // Broadcast diceCleared to ALL players (including roller)
      io.to(board_id).emit("diceCleared", clearResult);

      // Advance turn immediately, passing dice_value=null so it always shifts turns
      await advanceTurnAfterMove(io, board_id, player_id, null);
    }

    return;

  } catch (err: unknown) {
    console.error("Error in rollDice:", err);
    return safeAck({
      ok: false,
      msg: "Failed to roll dice",
      error: err instanceof Error ? err.message : "Unknown error"
    });
  }
};