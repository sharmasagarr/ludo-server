import prisma from "../config/prisma.js";
import handleFinalPos from "../utils/handleFinalPos.js";
import handleCapture from "../utils/handleCapture.js";
import { canPlayerAct, advanceTurnAfterMove } from "./turnState.js"; 
import { dangerZonePawnMove, buildPlayerStatsPayload } from "./dangerZonePawnMove.js";
import { Server } from "socket.io";
import { GameSocket } from "../types/index.js";

export const movePawn = async (io: Server, socket: GameSocket, payload: any, ack: any) => {
  const safeAck = (x: any) => { try { ack?.(x); } catch {} };

  try {
    const { board_id, pawn_id, player_id } = payload ?? {};

    if (!board_id || !pawn_id || !player_id) {
      return safeAck({ ok: false, msg: "Missing required fields" });
    }

    const can = await canPlayerAct(io, board_id, player_id);
    if (!can.ok && can.reason === "NOT_YOUR_TURN") {
      return safeAck({ ok: false, msg: "Not your turn" });
    }

    const result = await prisma.$transaction(async (tx: any) => {
      // BACKEND DICE SECURITY CHECK 
      const diceRoll = await tx.diceRoll.findUnique({ where: { player_id } });
      const dice_value = diceRoll?.dice_value;
      if (dice_value === null || dice_value === undefined) {
        throw new Error("You do not have an active dice roll to move with.");
      }

      const userBeforeMove = await tx.user.findUnique({ where: { id: player_id } });
      if (!userBeforeMove) throw new Error("User not found");

      const allPawnsBeforeMove = await tx.pawn.findMany({ where: { board_id } });
      const movingPawn = allPawnsBeforeMove.find((p: any) => p.id === pawn_id);
      if (!movingPawn) throw new Error(`Pawn not found: ${pawn_id}`);
      if (movingPawn.player_id !== player_id) throw new Error("Unauthorized pawn move");

      const moveResult = handleFinalPos(movingPawn.current_position, dice_value, movingPawn.color, movingPawn.type);
      if (!moveResult || moveResult.error) {
        throw new Error(`Invalid move: ${moveResult?.message || "Unknown error"}`);
      }
      
      const { finalPosition, finalType, is_safe, moves, startPosition, finalCellNum } = moveResult;
      const finalCellId = finalCellNum as number | undefined;
      const finalMoves = moves as number;

      const affectedPlayerIds = new Set([player_id]);
      const changedPawnIds = new Set([pawn_id]);

      // 1) Update moving pawn
      await tx.pawn.update({
        where: { id: pawn_id },
        data: {
          type: finalType,
          prev_position: String(movingPawn.current_position || ""),
          current_position: String(finalPosition || ""),
          is_safe: is_safe ? 1 : 0,
          moves: { increment: moves },
          last_moved_at: new Date()
        }
      });

      // Handle un-basing mechanics if moving into center/home
      if (finalType === 'center' || finalType === 'home') {
        const remainingMainPawns = await tx.pawn.count({ where: { player_id, board_id, type: 'main' } });
        const hasBasePawns = await tx.pawn.count({ where: { player_id, board_id, type: 'base' } });

        if (remainingMainPawns === 0 && hasBasePawns > 0) {
          const basePawnsToUnlock = await tx.pawn.findMany({
            where: { player_id, board_id, type: 'base' },
            take: 1
          });
          if (basePawnsToUnlock.length > 0) {
            await tx.pawn.update({
              where: { id: basePawnsToUnlock[0].id },
              data: { type: 'main', prev_position: '0', current_position: startPosition, last_moved_at: new Date() }
            });
            changedPawnIds.add(basePawnsToUnlock[0].id);
          }
        }
      }

      // Check if finished logic
      if (finalType === 'center' || finalPosition === 'finished') {
        const finishedPawns = await tx.pawn.count({ where: { player_id, board_id, type: 'center' } });
        if (finishedPawns === 4) {
          const boardBefore = await tx.board.findUnique({ where: { id: board_id } });
          if (boardBefore) {
            if (!boardBefore.winner1) {
              await tx.board.update({ where: { id: board_id }, data: { winner1: player_id } });
            } else if (!boardBefore.winner2) {
              await tx.board.update({ where: { id: board_id }, data: { winner2: player_id } });
            } else if (!boardBefore.winner3) {
              await tx.board.update({ where: { id: board_id }, data: { winner3: player_id } });
            }

            const boardAfter = await tx.board.findUnique({ where: { id: board_id } });
            if (boardAfter.winner3 && !boardAfter.loser) {
              const allPlayers = [boardAfter.player1, boardAfter.player2, boardAfter.player3, boardAfter.player4].filter(Boolean);
              const winners = [boardAfter.winner1, boardAfter.winner2, boardAfter.winner3];
              const remainingPlayer = allPlayers.find((p: string) => !winners.includes(p));
              if (remainingPlayer) {
                await tx.board.update({
                  where: { id: board_id },
                  data: { loser: remainingPlayer, status: "finished", end_time: new Date() }
                });
              }
            }
          }
        }
      }

      // 2) Update user moves
      await tx.user.update({
        where: { id: player_id },
        data: { current_move_balance: { increment: moves } }
      });

      // 3) Consume Dice
      await tx.diceRoll.update({
        where: { player_id },
        data: { dice_value: null }
      });

      const allPawnsAfterMove = await tx.pawn.findMany({ where: { board_id } });
      const movedPawnCheck = allPawnsAfterMove.find((p: any) => p.id === pawn_id);
      
      const captureResult = handleCapture(movedPawnCheck, allPawnsAfterMove);
      const { has_captured, captured_pawn_ids, kills } = captureResult;

      let captureLogs: any[] = [];
      
      // 4) Captures handling
      if (has_captured && Array.isArray(captured_pawn_ids) && captured_pawn_ids.length > 0) {
        await tx.user.update({
          where: { id: player_id },
          data: { kills: { increment: kills }, current_dice_roll_balance: { increment: 1 } }
        });
        
        await tx.pawn.update({
          where: { id: pawn_id },
          data: { kills: { increment: kills } }
        });

        const capPawns = await tx.pawn.findMany({ where: { id: { in: captured_pawn_ids } } });
        for (const row of capPawns) {
          affectedPlayerIds.add(row.player_id);
          const fromPos = String(row.current_position || "0");
          const moves_lost = Math.abs(row.moves || 0);
          
          const capturedFlmBefore = await tx.user.findUnique({ where: { id: row.player_id } });

          if (row.has_heart !== 1 || (row.has_heart === 1 && movedPawnCheck.has_heart === 1)) {
            // Base reset
            await tx.pawn.update({
              where: { id: row.id },
              data: {
                type: 'base',
                prev_position: fromPos,
                current_position: '0',
                moves: 0,
                moves_lost: { increment: moves_lost },
                is_safe: 1,
                has_heart: 0
              }
            });

            const removeCapturerHeart = (row.has_heart === 1 && movedPawnCheck.has_heart === 1) ? 1 : 0;
            // Capturing pawn gains captured pawn moves
            let gainedMoves = row.moves || 0;
            if (gainedMoves > 0) {
                await tx.pawn.update({
                  where: { id: pawn_id },
                  data: {
                    moves: { increment: gainedMoves },
                    has_heart: { decrement: removeCapturerHeart }
                  }
                });
            } else if (removeCapturerHeart > 0) {
                await tx.pawn.update({
                  where: { id: pawn_id },
                  data: {
                    has_heart: { decrement: removeCapturerHeart }
                  }
                });
            }

            const currentCapBal = Number(capturedFlmBefore?.current_move_balance) || 0;
            await tx.user.update({
              where: { id: row.player_id },
              data: { current_move_balance: Math.max(currentCapBal - (row.moves || 0), 0) }
            });
            await tx.user.update({
              where: { id: player_id },
              data: { current_move_balance: { increment: (row.moves || 0) } }
            });

            captureLogs.push({
              board_id,
              player_id: row.player_id,
              pawn_id: row.id,
              dice_value: null,
              from_position: fromPos,
              to_position: "0",
              has_captured: false,
              got_captured: true,
              captured_pawn_ids: null,
              actual_moves: -moves_lost,
              prev_move_balance: Number(capturedFlmBefore?.current_move_balance || 0),
              at_dice_roll_balance: Number(capturedFlmBefore?.current_dice_roll_balance || 0)
            });

            // Auto-unlock
            const remainingMainPawnsForCaptured = await tx.pawn.count({ where: { player_id: row.player_id, board_id, type: 'main' } });
            const hasBasePawnsForCaptured = await tx.pawn.count({ where: { player_id: row.player_id, board_id, type: 'base' } });
            
            if (remainingMainPawnsForCaptured === 0 && hasBasePawnsForCaptured > 0) {
              const homeAreaIdByColor: Record<string, number> = { blue: 1, red: 2, green: 3, yellow: 4 };
              const capturedStartPos = `cell-area-${homeAreaIdByColor[row.color as string]}-id-14`;
              const basePawnsToUnlockCaptured = await tx.pawn.findMany({
                where: { player_id: row.player_id, board_id, type: 'base' },
                take: 1
              });
              
              if (basePawnsToUnlockCaptured.length > 0) {
                await tx.pawn.update({
                  where: { id: basePawnsToUnlockCaptured[0].id },
                  data: { type: 'main', prev_position: '0', current_position: capturedStartPos, last_moved_at: new Date() }
                });
                changedPawnIds.add(basePawnsToUnlockCaptured[0].id);
              }
            }
          } else {
            await tx.pawn.update({ where: { id: row.id }, data: { has_heart: 0 } });
          }
        }
      }

      // Add main mover log
      captureLogs.unshift({
        board_id,
        player_id,
        pawn_id,
        dice_value,
        from_position: String(movingPawn.current_position || null),
        to_position: String(finalPosition || null),
        has_captured: has_captured ? true : false,
        got_captured: false,
        captured_pawn_ids: has_captured ? captured_pawn_ids : null,
        actual_moves: moves,
        prev_move_balance: Number(userBeforeMove.current_move_balance || 0),
        at_dice_roll_balance: Number(userBeforeMove.current_dice_roll_balance || 0)
      });

      await tx.moveLog.createMany({ data: captureLogs });

      // Generate delta snapshot inside tx context
      const updatedPawns = await tx.pawn.findMany({
        where: { id: { in: Array.from(changedPawnIds) } }
      });
      
      const updatedPlayers = await buildPlayerStatsPayload(tx, board_id, affectedPlayerIds);
      const updatedDiceRows = await tx.diceRoll.findMany({ where: { player_id } });

      return {
        updatedPawns,
        updatedPlayers,
        updatedDice: updatedDiceRows,
        finalCellId,
        finalMoves,
        movedPawnCheck
      };
    });

    const delta = {
      success: true,
      data: {
        board_id,
        updatedPawns: (result as any).updatedPawns,
        updatedPlayers: (result as any).updatedPlayers,
        updatedDice: (result as any).updatedDice,
        movedPawn: {
          pawn_id,
          player_id,
          prev_position: (result as any).movedPawnCheck?.prev_position || "",
          newPosition: (result as any).movedPawnCheck?.current_position || "",
          steps: (result as any).finalMoves
        }
      }
    };

    io.to(board_id).emit("pawnMoved", delta);
    
    // Check danger zone trigger
    const finalCellId = (result as any).finalCellId;
    if (finalCellId === 18 || finalCellId === 7 || finalCellId === 3) {
      // NOTE: Pass null explicitly for 'ack' to avoid issues
      await dangerZonePawnMove(io, socket, { board_id, pawn_id, player_id }, null);
    }
    
    // Advance turns
    await advanceTurnAfterMove(io, board_id, player_id, null); // passing null will advance
    
    return safeAck({ ok: true, msg: "Move committed & broadcast", ...delta });

  } catch (err: any) {
    if (err.message.includes("You do not have an active dice roll")) {
      return safeAck({ ok: false, msg: "You do not have an active dice roll to move with." });
    }
    console.error("Unexpected fatal error in movePawn:", err);
    return safeAck({ ok: false, msg: "Unexpected server error", error: err.message });
  }
};