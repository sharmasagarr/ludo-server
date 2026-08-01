import prisma from "../config/prisma.js";
import { Prisma } from "@prisma/client";
import { mapPawnToClient, strToPos, MappedPawn } from "../utils/positionMapper.js";
import handleFinalPos from "../utils/handleFinalPos.js";
import handleCapture from "../utils/handleCapture.js";
import { canPlayerAct, advanceTurnAfterMove } from "./turnState.js"; 
import { dangerZonePawnMove, buildPlayerStatsPayload } from "./dangerZonePawnMove.js";
import { Server } from "socket.io";
import { GameSocket } from "../types/index.js";

export const movePawn = async (
  io: Server,
  socket: GameSocket,
  payload: { board_id: string; pawn_id: string; player_id: string; [key: string]: unknown },
  ack: (response?: unknown) => void
) => {
  const safeAck = (x: unknown) => { try { ack?.(x); } catch {} };

  try {
    const { board_id, pawn_id, player_id } = payload ?? {};

    if (!board_id || !pawn_id || !player_id) {
      return safeAck({ ok: false, msg: "Missing required fields" });
    }

    const can = await canPlayerAct(io, board_id, player_id);
    if (!can.ok && can.reason === "NOT_YOUR_TURN") {
      return safeAck({ ok: false, msg: "Not your turn" });
    }

    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // BACKEND DICE SECURITY CHECK 
      const playerBp = await tx.boardPlayer.findUnique({ where: { board_id_user_id: { board_id, user_id: player_id } } });
      const dice_value = playerBp?.dice_value;
      if (dice_value === null || dice_value === undefined) {
        throw new Error("You do not have an active dice roll to move with.");
      }

      const userBeforeMove = await tx.boardPlayer.findUnique({ where: { board_id_user_id: { board_id, user_id: player_id } } });
      if (!userBeforeMove) throw new Error("User not found in board");

      const allPawnsBeforeMoveRaw = await tx.pawn.findMany({ where: { boardPlayer: { board_id } }, include: { boardPlayer: true } });
      const allPawnsBeforeMove = allPawnsBeforeMoveRaw.map(mapPawnToClient);
      const movingPawn = allPawnsBeforeMove.find((p: MappedPawn) => p.id === pawn_id);
      if (!movingPawn) throw new Error(`Pawn not found: ${pawn_id}`);
      if (movingPawn.board_player_id !== userBeforeMove.id) throw new Error("Unauthorized pawn move");

      const moveResult = handleFinalPos(movingPawn.current_position, dice_value, movingPawn.color as string, movingPawn.type as string);
      if (!moveResult || moveResult.error) {
        throw new Error(`Invalid move: ${moveResult?.message || "Unknown error"}`);
      }
      
      const { finalPosition, finalType, is_safe, moves, startPosition, finalCellNum } = moveResult;
      const finalCellId = finalCellNum as number | undefined;
      const finalMoves = moves as number;

      const affectedPlayerIds = new Set([player_id]);
      const changedPawnIds = new Set([pawn_id]);

      // 1) Update moving pawn
      const { area: next_area, cell: next_cell } = strToPos(finalPosition as string);
      const { area: prev_area, cell: prev_cell } = strToPos(movingPawn.current_position);

      await tx.pawn.update({
        where: { id: pawn_id },
        data: {
          cell_type: finalType as import("@prisma/client").CellType,
          prev_area,
          prev_cell,
          current_area: next_area,
          current_cell: next_cell,
          is_safe: is_safe ? true : false,
          moves: { increment: moves },
          last_moved_at: new Date()
        }
      });

      // Handle un-basing mechanics if moving into center/home
      if (finalType === 'center' || finalType === 'home') {
        const remainingMainPawns = await tx.pawn.count({ where: { board_player_id: userBeforeMove.id, cell_type: 'main' } });
        const hasBasePawns = await tx.pawn.count({ where: { board_player_id: userBeforeMove.id, cell_type: 'base' } });

        if (remainingMainPawns === 0 && hasBasePawns > 0) {
          const basePawnsToUnlock = await tx.pawn.findMany({
            where: { board_player_id: userBeforeMove.id, cell_type: 'base' },
            take: 1
          });
          if (basePawnsToUnlock.length > 0) {
            const { area: start_a, cell: start_c } = strToPos(startPosition as string);
            await tx.pawn.update({
              where: { id: basePawnsToUnlock[0].id },
              data: { cell_type: 'main', prev_area: null, prev_cell: null, current_area: start_a, current_cell: start_c, last_moved_at: new Date() }
            });
            changedPawnIds.add(basePawnsToUnlock[0].id);
          }
        }
      }

      // Check if finished logic
      if (finalType === 'center' || finalPosition === 'finished') {

        const finishedPawns = await tx.pawn.count({ where: { board_player_id: userBeforeMove.id, cell_type: 'center' } });
        if (finishedPawns === 4 && userBeforeMove.rank === null) {
          const finishedCount = await tx.boardPlayer.count({ where: { board_id, rank: { not: null } } });
          const newRank = finishedCount + 1;
          await tx.boardPlayer.update({ where: { id: userBeforeMove.id }, data: { rank: newRank } });
          
          if (newRank === 3) {
            const players = await tx.boardPlayer.findMany({ where: { board_id } });
            const loserBp = players.find(p => p.rank === null && p.id !== userBeforeMove.id);
            if (loserBp) {
              await tx.boardPlayer.update({ where: { id: loserBp.id }, data: { rank: 4, is_looser: true } });
              await tx.board.update({ where: { id: board_id }, data: { status: "finished", end_time: new Date() } });
            }
          }
        }
      }

      // 3) Consume Dice
      await tx.boardPlayer.update({
        where: { board_id_user_id: { board_id, user_id: player_id } },
        data: { dice_value: null }
      });

      const allPawnsAfterMoveRaw = await tx.pawn.findMany({ where: { boardPlayer: { board_id } }, include: { boardPlayer: true } });
      const allPawnsAfterMove = allPawnsAfterMoveRaw.map(mapPawnToClient);
      const movedPawnCheck = allPawnsAfterMove.find((p: MappedPawn) => p.id === pawn_id);
      if (!movedPawnCheck) throw new Error("Pawn not found after move");
      
      const captureResult = handleCapture(movedPawnCheck, allPawnsAfterMove);
      const { has_captured, captured_pawn_ids, kills } = captureResult;

      let captureLogs: Prisma.MoveLogCreateManyInput[] = [];
      
      // 4) Captures handling
      if (has_captured && Array.isArray(captured_pawn_ids) && captured_pawn_ids.length > 0) {
        await tx.boardPlayer.update({
          where: { board_id_user_id: { board_id, user_id: player_id } },
          data: { kills: { increment: kills } }
        });
        
        await tx.pawn.update({
          where: { id: pawn_id },
          data: { kills: { increment: kills } }
        });

        const capPawnsRaw = await tx.pawn.findMany({ where: { id: { in: captured_pawn_ids } }, include: { boardPlayer: true } });
        const capPawns = capPawnsRaw.map(mapPawnToClient);
        for (const row of capPawns) {
          const capturedFlmBefore = await tx.boardPlayer.findUnique({ where: { id: row.board_player_id } });
          if (!capturedFlmBefore) continue;
          
          affectedPlayerIds.add(capturedFlmBefore.user_id);
          const fromPos = String(row.current_position || "0");
          const moves_lost = Math.abs(row.moves || 0);
          const { area: from_area, cell: from_cell } = strToPos(fromPos);
          
          if (row.has_heart !== true || (row.has_heart === true && movedPawnCheck.has_heart === true)) {
            // Base reset
            await tx.pawn.update({
              where: { id: row.id },
              data: {
                cell_type: 'base',
                prev_area: from_area,
                prev_cell: from_cell,
                current_area: null,
                current_cell: null,
                moves: 0,
                moves_lost: { increment: moves_lost },
                is_safe: true,
                has_heart: false
              }
            });
            changedPawnIds.add(row.id);

            const removeCapturerHeart = (row.has_heart === true && movedPawnCheck.has_heart === true);
            // Capturing pawn gains captured pawn moves
            let gainedMoves = row.moves || 0;
            if (gainedMoves > 0) {
                await tx.pawn.update({
                  where: { id: pawn_id },
                  data: {
                    moves: { increment: gainedMoves },
                    has_heart: removeCapturerHeart ? false : undefined
                  }
                });
            } else if (removeCapturerHeart) {
                await tx.pawn.update({
                  where: { id: pawn_id },
                  data: {
                    has_heart: false
                  }
                });
            }

            captureLogs.push({
              board_player_id: capturedFlmBefore.id,
              pawn_id: row.id,
              dice_value: null,
              from_area,
              from_cell,
              to_area: null,
              to_cell: null,
              has_captured: false,
              got_captured: true,
              captured_pawn_ids: Prisma.DbNull,
              actual_moves: -moves_lost,
              prev_move_balance: 0
            });

            // Auto-unlock
            const remainingMainPawnsForCaptured = await tx.pawn.count({ where: { board_player_id: row.board_player_id, cell_type: 'main' } });
            const hasBasePawnsForCaptured = await tx.pawn.count({ where: { board_player_id: row.board_player_id, cell_type: 'base' } });
            
            if (remainingMainPawnsForCaptured === 0 && hasBasePawnsForCaptured > 0) {
              const homeAreaIdByColor: Record<string, number> = { blue: 1, red: 2, green: 3, yellow: 4, orange: 5, pink: 6 };
              const reqColor = row.color as string;
              const { area: unlock_a, cell: unlock_c } = { area: homeAreaIdByColor[reqColor], cell: 14 };
              const basePawnsToUnlockCaptured = await tx.pawn.findMany({
                where: { board_player_id: row.board_player_id, cell_type: 'base' },
                take: 1
              });
              
              if (basePawnsToUnlockCaptured.length > 0) {
                await tx.pawn.update({
                  where: { id: basePawnsToUnlockCaptured[0].id },
                  data: { cell_type: 'main', prev_area: null, prev_cell: null, current_area: unlock_a, current_cell: unlock_c, last_moved_at: new Date() }
                });
                changedPawnIds.add(basePawnsToUnlockCaptured[0].id);
              }
            }
          } else {
            await tx.pawn.update({ where: { id: row.id }, data: { has_heart: false } });
            changedPawnIds.add(row.id);
          }
        }
      }

      // Add main mover log
      const { area: to_area, cell: to_cell } = strToPos(finalPosition as string);
      captureLogs.unshift({
        board_player_id: userBeforeMove.id,
        pawn_id,
        dice_value,
        from_area: prev_area,
        from_cell: prev_cell,
        to_area,
        to_cell,
        has_captured: has_captured ? true : false,
        got_captured: false,
        captured_pawn_ids: has_captured ? captured_pawn_ids : Prisma.DbNull,
        actual_moves: moves,
        prev_move_balance: 0
      });

      await tx.moveLog.createMany({ data: captureLogs });

      // Generate delta snapshot inside tx context
      const updatedPawnsRaw = await tx.pawn.findMany({
        where: { id: { in: Array.from(changedPawnIds) } },
        include: { boardPlayer: true }
      });
      const updatedPawns = updatedPawnsRaw.map(mapPawnToClient);
      
      const updatedPlayers = await buildPlayerStatsPayload(tx, board_id, affectedPlayerIds);
      
      // Send the latest updated player bp dice rolls 
      const updatedDiceRows = await tx.boardPlayer.findMany({
        where: { board_id, user_id: player_id }
      });

      return {
        updatedPawns,
        updatedPlayers,
        updatedDice: updatedDiceRows,
        finalCellId,
        finalMoves,
        movedPawnCheck,
        original_dice_value: dice_value
      };
    });

    const delta = {
      success: true,
      data: {
        board_id,
        updatedPawns: result.updatedPawns,
        updatedPlayers: result.updatedPlayers,
        updatedDice: result.updatedDice,
        movedPawn: {
          pawn_id,
          player_id,
          prev_position: result.movedPawnCheck?.prev_position || "",
          newPosition: result.movedPawnCheck?.current_position || "",
          steps: result.finalMoves
        }
      }
    };

    io.to(board_id).emit("pawnMoved", delta);
    
    // Check danger zone trigger
    const finalCellId = result.finalCellId;
    if (finalCellId === 18 || finalCellId === 7 || finalCellId === 3) {
      // NOTE: Pass null explicitly for 'ack' to avoid issues
      await dangerZonePawnMove(io, socket, { board_id, pawn_id, player_id }, undefined);
    }
    
    // Advance turns
    const original_dice = result.original_dice_value;
    await advanceTurnAfterMove(io, board_id, player_id, original_dice);
    
    return safeAck({ ok: true, msg: "Move committed & broadcast", ...delta });

  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("You do not have an active dice roll")) {
      return safeAck({ ok: false, msg: "You do not have an active dice roll to move with." });
    }
    console.error("Unexpected fatal error in movePawn:", err);
    return safeAck({ ok: false, msg: "Unexpected server error", error: err instanceof Error ? err.message : "Unknown error" });
  }
};