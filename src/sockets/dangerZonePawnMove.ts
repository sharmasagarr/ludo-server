import prisma from "../config/prisma.js";
import handleDangerZoneMove from "../utils/handleDangerZoneMove.js";
import { Server } from "socket.io";
import { GameSocket } from "../types/index.js";
import { Prisma } from "@prisma/client";

// Helper for generating player payload across both socket flows
export const buildPlayerStatsPayload = async (tx: import("@prisma/client").Prisma.TransactionClient, board_id: string, affectedPlayerIds: Set<string>) => {
  if (affectedPlayerIds.size === 0) return [];
  
  const board = await tx.board.findUnique({ where: { id: board_id } });
  if (!board) return [];
  
  const allPlayerIds = [board.player1, board.player2, board.player3, board.player4].filter((p): p is string => Boolean(p));
  
  const allUsers = await tx.user.findMany({
    where: { id: { in: allPlayerIds } },
    include: {
      pawns: { where: { board_id } }
    }
  });
  
  const getWinPosition = (pid: string) => {
    if (board.winner1 === pid) return 1;
    if (board.winner2 === pid) return 2;
    if (board.winner3 === pid) return 3;
    if (board.loser === pid)  return 4;
    return null;
  };
  
  const processedPlayers = allUsers.map((u) => {
    let kills = 0;
    let moves = 0;
    let moves_lost = 0;
    let home = 0;
    let color = "";
    let last_moved_at = null;
    
    for (const p of u.pawns) {
      kills += Number(p.kills || 0);
      moves += Number(p.moves || 0);
      moves_lost += Number(p.moves_lost || 0);
      if (p.type === 'center') home++;
      if (!color && p.color) color = p.color;
      if (p.last_moved_at && (!last_moved_at || new Date(p.last_moved_at) > last_moved_at)) {
        last_moved_at = p.last_moved_at;
      }
    }
    
    return {
      player_id: u.id,
      playerName: u.name,
      kills,
      current_dice_roll_balance: Number(u.current_dice_roll_balance || 0),
      current_move_balance: Number(u.current_move_balance || 0),
      moves,
      moves_lost,
      color,
      home,
      winPosition: getWinPosition(u.id),
      last_moved_at
    };
  });
  
  const sortedByMoves = [...processedPlayers].sort((a, b) => b.moves - a.moves);
  
  const finalPayload = processedPlayers
    .filter((p) => affectedPlayerIds.has(p.player_id))
    .map((p) => ({
      ...p,
      rank: sortedByMoves.findIndex(sp => sp.player_id === p.player_id) + 1
    }));
    
  return finalPayload;
};

export const dangerZonePawnMove = async (io: Server, socket: GameSocket, payload: { board_id: string; pawn_id: string; player_id: string; [key: string]: unknown }, ack?: (response?: unknown) => void) => {
  const safeAck = (x: unknown) => { try { ack?.(x); } catch {} };

  try {
    const { board_id, pawn_id, player_id } = payload ?? {};

    if (!board_id || !pawn_id || !player_id) {
      console.error("Missing required fields", { board_id, pawn_id, player_id });
      return safeAck({ ok: false, msg: "Missing required fields" });
    }

    const result = await prisma.$transaction(async (tx: import("@prisma/client").Prisma.TransactionClient) => {
      // 1) Load pawn
      const pawnRow = await tx.pawn.findUnique({ where: { id: pawn_id } });
      if (!pawnRow || pawnRow.board_id !== board_id) throw new Error("Pawn not found for this board");
      if (pawnRow.player_id !== player_id) throw new Error("You cannot move this pawn");

      // Load user
      const flmBeforeMove = await tx.user.findUnique({ where: { id: player_id } });
      if (!flmBeforeMove) throw new Error("User not found");

      // 2) Apply danger zone movement
      const { newPosition, moves_lost } = handleDangerZoneMove(
        pawnRow.current_position,
        pawnRow.color as string
      );

      if (moves_lost <= 0 || !newPosition || newPosition === pawnRow.current_position) {
        return { noDanger: true };
      }

      const affectedPlayerIds = new Set([player_id]);
      const changedPawnIds = new Set([pawn_id]);

      // 3) Update pawn going backwards
      const newPawnMoves = Math.max(Number(pawnRow.moves || 0) - moves_lost, 0);
      await tx.pawn.update({
        where: { id: pawn_id },
        data: {
          prev_position: String(pawnRow.current_position || ""),
          current_position: String(newPosition),
          moves: newPawnMoves,
          moves_lost: { increment: moves_lost },
          last_moved_at: new Date()
        }
      });

      // 4) Update user FLM
      const newUserMovesParams = Math.max(Number(flmBeforeMove.current_move_balance || 0) - moves_lost, 0);
      await tx.user.update({
        where: { id: player_id },
        data: { current_move_balance: newUserMovesParams }
      });

      // 5) Fetch pawns again to check for collisions
      const pawnsAfterMove = await tx.pawn.findMany({ where: { board_id } });
      const backwardPawn = pawnsAfterMove.find((p: import("@prisma/client").Pawn) => p.id === pawn_id);

      let has_captured = false;
      let captured_pawn_ids: string[] = [];
      let captureLogs: import("@prisma/client").Prisma.MoveLogCreateManyInput[] = [];
      let kills = 0;

      const capturerPawn = pawnsAfterMove.find((p: import("@prisma/client").Pawn) =>
        p.current_position === backwardPawn?.current_position &&
        p.id !== pawn_id &&
        p.player_id !== backwardPawn?.player_id &&
        p.type !== "base" && p.type !== "center" &&
        !p.is_safe
      );

      if (capturerPawn) {
        affectedPlayerIds.add(capturerPawn.player_id);
        const capturedPawn = backwardPawn as import("@prisma/client").Pawn;
        const capturedPlayerId = capturedPawn.player_id;
        const capturedFromPos = String(capturedPawn.current_position || "0");
        
        const capturedFlmBefore = await tx.user.findUnique({ where: { id: capturedPlayerId } });
        has_captured = true;
        captured_pawn_ids = [capturedPawn.id];
        kills = 1;

        if (capturedPawn.has_heart !== true) {
          // Send captured pawn back to base
          await tx.pawn.update({
             where: { id: capturedPawn.id },
             data: {
                type: 'base',
                prev_position: capturedFromPos,
                current_position: '0',
                moves_lost: { increment: Number(capturedPawn.moves || 0) },
                moves: 0,
            is_safe: true,
            has_heart: false
             }
          });

          // Capturer gains those moves
          await tx.pawn.update({
            where: { id: capturerPawn.id },
            data: { moves: { increment: Number(capturedPawn.moves || 0) } }
          });

          // Captured user loses move balance
          const remainingCapturedBal = Math.max(Number(capturedFlmBefore?.current_move_balance || 0) - Number(capturedPawn.moves || 0), 0);
          await tx.user.update({
            where: { id: capturedPlayerId },
            data: { current_move_balance: remainingCapturedBal }
          });

          // Capturer gains kills + moves + dice roll balance
          await tx.user.update({
            where: { id: capturerPawn.player_id },
            data: {
              current_move_balance: { increment: Number(capturedPawn.moves || 0) },
              kills: { increment: kills },
              current_dice_roll_balance: { increment: 1 }
            }
          });

          captureLogs.push({
            board_id,
            player_id: capturedPlayerId,
            pawn_id: capturedPawn.id,
            dice_value: null,
            from_position: capturedFromPos,
            to_position: "0",
            has_captured: false,
            got_captured: true,
            captured_pawn_ids: Prisma.DbNull,
            actual_moves: -Math.abs(capturedPawn.moves || 0),
            prev_move_balance: Number(capturedFlmBefore?.current_move_balance || 0),
            at_dice_roll_balance: Number(capturedFlmBefore?.current_dice_roll_balance || 0)
          });

          // Auto unlock logic for captured player
          const remainingMainPawns = await tx.pawn.count({
            where: { player_id: capturedPlayerId, board_id, type: 'main' }
          });
          const hasBasePawns = await tx.pawn.count({
            where: { player_id: capturedPlayerId, board_id, type: 'base' }
          });

          if (remainingMainPawns === 0 && hasBasePawns > 0) {
            const homeAreaIdByColor: Record<string, number> = { blue: 1, red: 2, green: 3, yellow: 4 };
            const startPos = `cell-area-${homeAreaIdByColor[capturedPawn.color as string]}-id-14`;
            
            const basePawnsToUnlock = await tx.pawn.findMany({
              where: { player_id: capturedPlayerId, board_id, type: 'base' },
              take: 1
            });
            
            if (basePawnsToUnlock.length > 0) {
              await tx.pawn.update({
                where: { id: basePawnsToUnlock[0].id },
                data: { type: 'main', prev_position: '0', current_position: startPos, last_moved_at: new Date() }
              });
              changedPawnIds.add(basePawnsToUnlock[0].id);
            }
          }
        } else {
          // Pawn has heart, just remove heart
          await tx.pawn.update({ where: { id: capturedPawn.id }, data: { has_heart: false } });
        }

        // Update capturer strictly
        await tx.pawn.update({
          where: { id: capturerPawn.id },
          data: { kills: { increment: kills } }
        });
        changedPawnIds.add(capturerPawn.id);
      }

      // Log backward move itself
      captureLogs.unshift({
          board_id,
          player_id,
          pawn_id,
          dice_value: null,
          from_position: String(pawnRow.current_position || null),
          to_position: String(newPosition || null),
          has_captured: false,
          got_captured: has_captured ? true : false,
          captured_pawn_ids: has_captured ? captured_pawn_ids : Prisma.DbNull,
          actual_moves: -moves_lost,
          prev_move_balance: Number(flmBeforeMove?.current_move_balance || 0),
          at_dice_roll_balance: Number(flmBeforeMove?.current_dice_roll_balance || 0)
      });
      
      await tx.moveLog.createMany({ data: captureLogs });

      const updatedPawns = await tx.pawn.findMany({
        where: { id: { in: Array.from(changedPawnIds) } }
      });
      
      const updatedPlayers = await buildPlayerStatsPayload(tx, board_id, affectedPlayerIds);

      return {
        updatedPawns,
        updatedPlayers,
        movedPawn: backwardPawn,
        moves_lost
      };
    });

    if (result && 'noDanger' in result && result.noDanger) {
      return safeAck({ ok: true, msg: "No danger-zone move applied", data: null });
    }

    const res = result as {
      updatedPawns: import("@prisma/client").Pawn[];
      updatedPlayers: Record<string, unknown>[];
      movedPawn: import("@prisma/client").Pawn | undefined;
      moves_lost: number;
    };

    const delta = {
      success: true,
      data: {
        board_id,
        updatedPawns: res.updatedPawns,
        updatedPlayers: res.updatedPlayers,
        updatedDice: [],
        movedPawn: {
          pawn_id,
          player_id,
          prev_position: res.movedPawn?.prev_position || "",
          newPosition: res.movedPawn?.current_position || "",
          steps: -res.moves_lost,
        }
      }
    };

    io.to(board_id).emit("pawnMoved", delta);
    return safeAck({ ok: true, msg: "Danger move + capture handled", ...delta });
    
  } catch (err: unknown) {
    console.error("Fatal error in dangerZonePawnMove:", err);
    return safeAck({ ok: false, msg: "Unexpected server error", error: err instanceof Error ? err.message : "Unknown error" });
  }
};
