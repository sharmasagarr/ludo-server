import prisma from "../config/prisma.js";
import handleDangerZoneMove from "../utils/handleDangerZoneMove.js";
import { Server } from "socket.io";
import { GameSocket } from "../types/index.js";
import { Prisma } from "@prisma/client";
import { mapPawnToClient, strToPos, MappedPawn } from "../utils/positionMapper.js";

// Helper for generating player payload across both socket flows
export const buildPlayerStatsPayload = async (tx: import("@prisma/client").Prisma.TransactionClient, board_id: string, affectedPlayerIds: Set<string>) => {
  if (affectedPlayerIds.size === 0) return [];
  
  const bps = await tx.boardPlayer.findMany({
    where: { board_id },
    include: { user: true, pawns: true }
  });
  
  const getWinPosition = (bp: import("@prisma/client").BoardPlayer) => {
    return bp.rank;
  };
  
  const processedPlayers = bps.map((bp) => {
    let kills = 0;
    let moves = 0;
    let moves_lost = 0;
    let home = 0;
    let color = "";
    let last_moved_at: Date | null = null;
    
    for (const p of bp.pawns) {
      kills += Number(p.kills || 0);
      moves += Number(p.moves || 0);
      moves_lost += Number(p.moves_lost || 0);
      if (p.cell_type === 'center') home++;
      if (!color && bp.color) color = bp.color;
      if (p.last_moved_at && (!last_moved_at || new Date(p.last_moved_at) > last_moved_at)) {
        last_moved_at = p.last_moved_at;
      }
    }
    
    return {
      player_id: bp.user_id,
      playerName: bp.user.name,
      kills,
      moves,
      moves_lost,
      color,
      home,
      winPosition: getWinPosition(bp),
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

export const dangerZonePawnMove = async (io: Server, _socket: GameSocket, payload: { board_id: string; pawn_id: string; player_id: string; [key: string]: unknown }, ack?: (response?: unknown) => void) => {
  const safeAck = (x: unknown) => { try { ack?.(x); } catch {} };

  try {
    const { board_id, pawn_id, player_id } = payload ?? {};

    if (!board_id || !pawn_id || !player_id) {
      console.error("Missing required fields", { board_id, pawn_id, player_id });
      return safeAck({ ok: false, msg: "Missing required fields" });
    }

    const result = await prisma.$transaction(async (tx: import("@prisma/client").Prisma.TransactionClient) => {
      // 1) Load pawn
      const flmBeforeMove = await tx.boardPlayer.findUnique({ where: { board_id_user_id: { board_id, user_id: player_id } } });
      if (!flmBeforeMove) throw new Error("User not found in board");
      const pawnRowRaw = await tx.pawn.findUnique({ where: { id: pawn_id }, include: { boardPlayer: true } });
      if (!pawnRowRaw || pawnRowRaw.boardPlayer.board_id !== board_id) throw new Error("Pawn not found for this board");
      const pawnRow = mapPawnToClient(pawnRowRaw);
      if (pawnRow.board_player_id !== flmBeforeMove.id) throw new Error("You cannot move this pawn");

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
      const { area: next_area, cell: next_cell } = strToPos(newPosition as string);
      const { area: prev_area, cell: prev_cell } = strToPos(pawnRow.current_position);

      await tx.pawn.update({
        where: { id: pawn_id },
        data: {
          prev_area,
          prev_cell,
          current_area: next_area,
          current_cell: next_cell,
          moves: newPawnMoves,
          moves_lost: { increment: moves_lost },
          last_moved_at: new Date()
        }
      });

      // 5) Fetch pawns again to check for collisions
      const pawnsAfterMoveRaw = await tx.pawn.findMany({ where: { boardPlayer: { board_id } }, include: { boardPlayer: true } });
      const pawnsAfterMove = pawnsAfterMoveRaw.map(mapPawnToClient);
      const backwardPawn = pawnsAfterMove.find((p: MappedPawn) => p.id === pawn_id);

      let has_captured = false;
      let captured_pawn_ids: string[] = [];
      let captureLogs: import("@prisma/client").Prisma.MoveLogCreateManyInput[] = [];
      let kills = 0;

      const capturerPawn = pawnsAfterMove.find((p: MappedPawn) =>
        p.current_position === backwardPawn?.current_position &&
        p.id !== pawn_id &&
        p.board_player_id !== backwardPawn?.board_player_id &&
        p.type !== "base" && p.type !== "center" &&
        !p.is_safe
      );

      if (capturerPawn) {
        const capturerBp = await tx.boardPlayer.findUnique({ where: { id: capturerPawn.board_player_id } });
        affectedPlayerIds.add(capturerBp?.user_id || "");
        const capturedPawn = backwardPawn as MappedPawn;
        const capturedPlayerId = player_id;
        const capturedFromPos = String(capturedPawn.current_position || "0");
        
        const capturedFlmBefore = await tx.boardPlayer.findUnique({ where: { board_id_user_id: { board_id, user_id: capturedPlayerId } } });
        has_captured = true;
        captured_pawn_ids = [capturedPawn.id];
        kills = 1;

        if (capturedPawn.has_heart !== true) {
          const { area: from_area, cell: from_cell } = strToPos(capturedFromPos);
          // Send captured pawn back to base
          await tx.pawn.update({
             where: { id: capturedPawn.id },
             data: {
                cell_type: 'base',
                prev_area: from_area,
                prev_cell: from_cell,
                current_area: null,
                current_cell: null,
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

          // Capturer gains kills + moves
          if (capturerBp) {
            await tx.boardPlayer.update({
              where: { id: capturerBp.id },
              data: {
                kills: { increment: kills }
              }
            });
          }

          const { area: to_cap_a, cell: to_cap_c } = strToPos(capturedFromPos);
          captureLogs.push({
            board_player_id: capturedFlmBefore!.id,
            pawn_id: capturedPawn.id,
            dice_value: null,
            from_area: to_cap_a,
            from_cell: to_cap_c,
            to_area: null,
            to_cell: null,
            has_captured: false,
            got_captured: true,
            captured_pawn_ids: Prisma.DbNull,
            actual_moves: -Math.abs(capturedPawn.moves || 0),
            prev_move_balance: 0
          });

          // Auto unlock logic for captured player
          const remainingMainPawns = await tx.pawn.count({
            where: { board_player_id: flmBeforeMove.id, cell_type: 'main' }
          });
          const hasBasePawns = await tx.pawn.count({
            where: { board_player_id: flmBeforeMove.id, cell_type: 'base' }
          });

          if (remainingMainPawns === 0 && hasBasePawns > 0) {
            const homeAreaIdByColor: Record<string, number> = { blue: 1, red: 2, green: 3, yellow: 4, orange: 5, pink: 6 };
            const reqColor = capturedPawn.color as string;
            const { area: unlock_a, cell: unlock_c } = { area: homeAreaIdByColor[reqColor], cell: 14 };
            
            const basePawnsToUnlock = await tx.pawn.findMany({
              where: { board_player_id: flmBeforeMove.id, cell_type: 'base' },
              take: 1
            });
            
            if (basePawnsToUnlock.length > 0) {
              await tx.pawn.update({
                where: { id: basePawnsToUnlock[0].id },
                data: { cell_type: 'main', prev_area: null, prev_cell: null, current_area: unlock_a, current_cell: unlock_c, last_moved_at: new Date() }
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
      const { area: back_prev_a, cell: back_prev_c } = strToPos(pawnRow.current_position);
      const { area: back_curr_a, cell: back_curr_c } = strToPos(newPosition as string);
      captureLogs.unshift({
          board_player_id: flmBeforeMove.id,
          pawn_id,
          dice_value: null,
          from_area: back_prev_a,
          from_cell: back_prev_c,
          to_area: back_curr_a,
          to_cell: back_curr_c,
          has_captured: false,
          got_captured: has_captured ? true : false,
          captured_pawn_ids: has_captured ? captured_pawn_ids : Prisma.DbNull,
          actual_moves: -moves_lost,
          prev_move_balance: 0
      });
      
      await tx.moveLog.createMany({ data: captureLogs });

      const updatedPawnsRaw = await tx.pawn.findMany({
        where: { id: { in: Array.from(changedPawnIds) } },
        include: { boardPlayer: true }
      });
      const updatedPawns = updatedPawnsRaw.map(mapPawnToClient);
      
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
      updatedPawns: MappedPawn[];
      updatedPlayers: Record<string, unknown>[];
      movedPawn: MappedPawn | undefined;
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
