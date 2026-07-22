import db from "../config/db.js";
import handleFinalPos from "../utils/handleFinalPos.js";
import handleCapture from "../utils/handleCapture.js";
import { canPlayerAct, advanceTurnAfterMove } from "./turnState.js"; 
import { dangerZonePawnMove } from "./dangerZonePawnMove.js";

export const movePawn = async (io, socket, payload, ack) => {
  const safeAck = (x) => { try { ack?.(x); } catch {} };

  let conn = null;

  try {
    const {
      board_id,
      pawn_id,
      player_id,
    } = payload ?? {};
    
    let dice_value = null;

    // --- Input validation
    if (!board_id || !pawn_id || !player_id) {
      console.error("Validation error: Missing required fields", { board_id, pawn_id, player_id });
      return safeAck({ 
        ok: false, 
        msg: "Missing required fields: board_id, pawn_id, or player_id" 
      });
    }

    // 🔒 TURN & BALANCE CHECK
    const can = await canPlayerAct(io, board_id, player_id);
    if (!can.ok && can.reason === "NOT_YOUR_TURN") {
      return safeAck({ ok: false, msg: "Not your turn" });
    }

    // --- Get database connection
    try {
      conn = await db.getConnection();
    } catch (connErr) {
      console.error("Database connection error:", connErr);
      return safeAck({ 
        ok: false, 
        msg: "Failed to establish database connection", 
        error: connErr.message
      });
    }

    // track the affected players for snapshot later
    const affectedPlayerIds = new Set();
    const changedPawnIds = new Set();
    if (player_id) affectedPlayerIds.add(player_id);
    let movingPawn;
    let movedPawn;
    let has_captured = 0;
    let captured_pawn_ids = [];
    let kills = 0;
    let finalCellId;
    let finalMoves = 0;

    try {
      // Start transaction
      await conn.beginTransaction();

      // BACKEND DICE SECURITY CHECK 
      const [diceRows] = await conn.execute(
        `SELECT dice_value FROM dice_rolls WHERE player_id = ? FOR UPDATE`,
        [player_id]
      );
      
      dice_value = diceRows[0]?.dice_value;
      if (dice_value === null || dice_value === undefined) {
        await conn.rollback();
        return safeAck({ 
          ok: false, 
          msg: "You do not have an active dice roll to move with.", 
        });
      }

      // getuserBeforeMove
      const [userBeforeMoveRows] = await conn.execute(
        `SELECT current_dice_roll_balance, current_move_balance FROM users
        WHERE id = ?`,
        [player_id]
      );

      const userBeforeMove = userBeforeMoveRows[0];

      // getAllPawnsBeforeMove
      const [allPawnsBeforeMove] = await conn.execute(
        `SELECT * FROM pawns
        WHERE board_id = ?`,
        [board_id]
      );
      
      movingPawn = allPawnsBeforeMove.find((pawn) => pawn.id === pawn_id);
      if (!movingPawn) {
        throw new Error(`Pawn not found: ${pawn_id}`);
      }
      const moveResult = handleFinalPos(movingPawn.current_position, dice_value, movingPawn.color, movingPawn.type);
      if (!moveResult || moveResult.error) {
        throw new Error(`Invalid move: ${moveResult?.message || "Unknown error"}`);
      }
      const { finalPosition, finalType, is_safe, moves, startPosition, finalCellNum } = moveResult;
      finalCellId = finalCellNum;
      finalMoves = moves;
      
      // 1) Update moving pawn
      try {
        const [updateResult] = await conn.execute(
          `UPDATE pawns
            SET type = ?, prev_position = ?, current_position = ?, is_safe = ?, moves = moves + ?, last_moved_at = NOW()
          WHERE id = ? AND player_id = ? AND board_id = ?`,
          [finalType, movingPawn.current_position != null ? String(movingPawn.current_position) : null, finalPosition != null ? String(finalPosition) : null, is_safe, moves, pawn_id, player_id, board_id]
        );

        if (updateResult.affectedRows === 0) {
          throw new Error(`No pawn found with id=${pawn_id}, player_id=${player_id}, board_id=${board_id}`);
        }

        if (finalType === 'center' || finalType === 'home') {
          const [[result]] = await conn.execute(
            `SELECT 
              NOT EXISTS (SELECT 1 FROM pawns WHERE player_id = ? AND board_id = ? AND type = 'main') as noMainPawns,
              EXISTS (SELECT 1 FROM pawns WHERE player_id = ? AND board_id = ? AND type = 'base') as hasBasePawns
            `,
            [player_id, board_id, player_id, board_id]
          );

          // If no main pawns AND has base pawns, unlock one
          if (result.noMainPawns === 1 && result.hasBasePawns === 1) {
            await conn.execute(
              `UPDATE pawns 
              SET type = 'main', prev_position = '0', current_position = ?, last_moved_at = NOW()
              WHERE player_id = ? AND board_id = ? AND type = 'base'
              LIMIT 1`,
              [startPosition, player_id, board_id]
            );
            // Get the updated pawn to emit to clients
            const [[unlockedPawn]] = await conn.execute(
              `SELECT * FROM pawns 
              WHERE player_id = ? AND board_id = ? AND type = 'main'
              ORDER BY last_moved_at DESC LIMIT 1`,
              [player_id, board_id]
            );
            changedPawnIds.add(unlockedPawn?.id);
          }
        }

        // Check if the pawn reached finished position
        if (finalType === 'center' || finalPosition === 'finished') {
          // Count how many pawns are finished for this player in this board
          const [finishedPawns] = await conn.execute(
            `SELECT COUNT(*) as finishedCount 
            FROM pawns 
            WHERE player_id = ? AND board_id = ? AND type = 'center'`,
            [player_id, board_id]
          );

          // If all 4 pawns are finished, update the boards table
          if (finishedPawns[0].finishedCount === 4) {

            // Check current board state first
            const [currentBoardState] = await conn.execute(
              `SELECT winner1, winner2, winner3 FROM boards WHERE id = ?`,
              [board_id]
            );
            
            const boardBefore = currentBoardState[0];

            if (boardBefore.winner1 === null) {
              await conn.execute(`UPDATE boards SET winner1 = ? WHERE id = ?`, [player_id, board_id]);
            } else if (boardBefore.winner2 === null) {
              await conn.execute(`UPDATE boards SET winner2 = ? WHERE id = ?`, [player_id, board_id]);
            } else if (boardBefore.winner3 === null) {
              await conn.execute(`UPDATE boards SET winner3 = ? WHERE id = ?`, [player_id, board_id]);
            }

            // Check if winner3 was just filled
            const [boardState] = await conn.execute(
              `SELECT winner1, winner2, winner3, loser, player1, player2, player3, player4 
              FROM boards 
              WHERE id = ?`,
              [board_id]
            );

            const board = boardState[0];

            // If winner3 is now filled and loser is still NULL, find the remaining player
            if (board.winner3 !== null && board.loser === null) {
              // Create array of all players
              const allPlayers = [board.player1, board.player2, board.player3, board.player4].filter(p => p !== null);
              
              // Create array of winners
              const winners = [board.winner1, board.winner2, board.winner3];
              
              // Find the player who is not in winners list
              const remainingPlayer = allPlayers.find(player => !winners.includes(player));
              
              if (remainingPlayer) {
                await conn.execute(
                  `UPDATE boards SET loser = ?, actualEndTime = NOW(), status="finished" WHERE id = ?`,
                  [remainingPlayer, board_id]
                );
              }
            }
          }
        }
      } catch (pawnUpdateErr) {
        console.error("Error updating pawn position:", pawnUpdateErr);
        throw new Error(`Failed to update pawn position: ${pawnUpdateErr.message}`);
      }

      // 2) Update user moves
      try {
        const [updateuserResult] = await conn.execute(
          `UPDATE users  
            SET current_move_balance = current_move_balance + ?
          WHERE id = ? `,
          [moves, player_id]
        );

        if (updateuserResult.affectedRows === 0) {
          throw new Error(`No pawn found with id=${pawn_id}, player_id=${player_id}, board_id=${board_id}`);
        }
      } catch (userUpdateErr) {
        console.error("Error updating user moves:", userUpdateErr);
        throw new Error(`Failed to update user moves: ${userUpdateErr.message}`);
      }

      // 3) Update dice value to null meaning consumed
      try {
        const [diceUpdateResult] = await conn.execute(
          `UPDATE dice_rolls 
              SET dice_value = null
            WHERE player_id = ?`,
          [player_id]
        );

        if (diceUpdateResult.affectedRows === 0) {
          throw new Error(`No dice found with id=${player_id}`);
        }
      } catch (diceUpdateErr) {
        console.error("Error updating dice value:", diceUpdateErr);
        throw new Error(`Failed to update dice values: ${diceUpdateErr.message}`);
      }
      
      // getAllPawnsAfterMove
      const [allPawnsAfterMove] = await conn.execute(
        `SELECT * FROM pawns
        WHERE board_id = ?`,
        [board_id]
      );

      movedPawn = allPawnsAfterMove.find((pawn) => pawn.id === pawn_id);
      const captureResult = handleCapture(movedPawn, allPawnsAfterMove);

      // 🔹 assign to outer variables
      has_captured = captureResult.has_captured;
      captured_pawn_ids = captureResult.captured_pawn_ids;
      kills = captureResult.kills;

      // 4) Update kills if captured
      if (has_captured) {
        try {
          const captureCount = captured_pawn_ids?.length || 0;
          if (captureCount === 0) {
            throw new Error("has_captured is true but captured_pawn_ids is empty");
          }

          const [userkillUpdateResult] = await conn.execute(
            `UPDATE users 
              SET kills = kills + ?,
                  current_dice_roll_balance = current_dice_roll_balance + 1
             WHERE id = ?`,
            [kills, player_id]
          );

          const [pawnkillUpdateResult] = await conn.execute(
            `UPDATE pawns 
              SET kills = kills + ?
             WHERE id = ?`,
            [kills, pawn_id]
          );

          if (userkillUpdateResult.affectedRows === 0) {
            throw new Error(`No player found with id=${player_id} for kill update`);
          } else if (pawnkillUpdateResult.affectedRows === 0) {
            throw new Error(`No pawn found with pawn_id=${pawn_id} for kill update`);
          }
        } catch (killUpdateErr) {
          console.error("Error updating player kills:", killUpdateErr);
          throw new Error(`Failed to update player kills: ${killUpdateErr.message}`);
        }
      }

      // 5) Prepare move_logs rows (mover + captured)
      const logRows = [
        [
          board_id,
          player_id,
          pawn_id,
          dice_value,
          movingPawn.current_position != null ? String(movingPawn.current_position) : null,
          finalPosition != null ? String(finalPosition) : null,
          has_captured ? 1 : 0,
          0,
          JSON.stringify(captured_pawn_ids),
          moves,
          userBeforeMove.current_move_balance,
          userBeforeMove.current_dice_roll_balance,
        ],
      ];

      // 6) Handle captured pawns move swap from captured to capturing
      if (has_captured && Array.isArray(captured_pawn_ids) && captured_pawn_ids.length) {
        try {
          const placeholders = captured_pawn_ids.map(() => "?").join(",");
          const [capPawnRows] = await conn.query(
            `SELECT id, player_id, current_position, moves, has_heart, color
              FROM pawns
              WHERE id IN (${placeholders})`,
            captured_pawn_ids
          );

          if (capPawnRows.length !== captured_pawn_ids.length) {
            throw new Error(
              `Mismatch: Expected ${captured_pawn_ids.length} captured pawns, found ${capPawnRows.length}`
            );
          }

          for (const row of capPawnRows) {
            const fromPos = row.current_position != null ? String(row.current_position) : null;
            const moves_lost = -Math.abs(row.moves);
            const capturedPlayerId = row.player_id;
            
            const [captureduserBeforeMoveRows] = await conn.execute(
              `SELECT current_dice_roll_balance, current_move_balance FROM users
              WHERE id = ?
              `, [capturedPlayerId]
            );
            const captureduserBeforeMove = captureduserBeforeMoveRows[0];
            
            // Capture if: (1) captured pawn has no heart, OR (2) both pawns have hearts
            if (row.has_heart !== 1 || (row.has_heart === 1 && movedPawn.has_heart === 1)) {
              // Send captured pawn back to base
              const [capturedPawnUpdateResult] = await conn.execute(
                `UPDATE pawns
                    SET type = 'base',
                        prev_position = ?,
                        current_position = '0',
                        moves = 0,
                        moves_lost = moves_lost + ?,
                        is_safe = 1,
                        has_heart = 0
                  WHERE id = ?`,
                [fromPos, row.moves, row.id]
              );
              
              // Update capturing pawn: gain moves and remove heart if both had hearts
              const removeCapturerHeart = (row.has_heart === 1 && movedPawn.has_heart === 1) ? 1 : 0;
              const [capturingPawnUpdateResult] = await conn.execute(
                `UPDATE pawns
                    SET moves = moves + ?,
                        has_heart = GREATEST(has_heart - ?, 0)
                  WHERE id = ?`,
                [row.moves, removeCapturerHeart, pawn_id]
              );
              
              // update moves in captured user row
              const [captureduserUpdateResult] = await conn.execute(
                `UPDATE users
                    SET current_move_balance = current_move_balance - ?
                  WHERE id = ?`,
                [row.moves, capturedPlayerId]
              );
              
              // update moves in capturing user row
              const [capturinguserUpdateResult] = await conn.execute(
                `UPDATE users
                    SET current_move_balance = current_move_balance + ?,
                        moves = moves + ?
                  WHERE id = ?`,
                [row.moves, row.moves, player_id]
              );
              
              if (capturedPawnUpdateResult.affectedRows === 0 ||
                  capturingPawnUpdateResult.affectedRows === 0 ||
                  captureduserUpdateResult.affectedRows === 0 ||
                  capturinguserUpdateResult.affectedRows === 0) {
                throw new Error(`Failed to reset captured pawn and user moves with id=${row.id}`);
              }

              // ✅ Log entry for pawn sent back to base
              logRows.push([
                board_id,
                capturedPlayerId,
                row.id,
                null,
                fromPos,
                "0",
                0,
                1,
                null,
                moves_lost,
                captureduserBeforeMove.current_move_balance,
                captureduserBeforeMove.current_dice_roll_balance
              ]);

              // 🔥 Auto-unlock logic for captured player
              const [[capturedPlayerStatus]] = await conn.execute(
                `SELECT 
                  NOT EXISTS (SELECT 1 FROM pawns WHERE player_id = ? AND board_id = ? AND type = 'main') as noMainPawns,
                  EXISTS (SELECT 1 FROM pawns WHERE player_id = ? AND board_id = ? AND type = 'base') as hasBasePawns
                `,
                [capturedPlayerId, board_id, capturedPlayerId, board_id]
              );

              // If captured player has no main pawns AND has base pawns, unlock one
              if (capturedPlayerStatus.noMainPawns === 1 && capturedPlayerStatus.hasBasePawns === 1) {
                const homeAreaIdByColor = {
                  blue: 1,
                  red: 2,
                  green: 3,
                  yellow: 4,
                };
                const capturedPlayerStartPosition = `cell-area-${homeAreaIdByColor[row.color]}-id-14`;

                const [unlockedResult] = await conn.execute(
                  `UPDATE pawns 
                  SET type = 'main', prev_position = '0', current_position = ?, last_moved_at = NOW()
                  WHERE player_id = ? AND board_id = ? AND type = 'base'
                  LIMIT 1`,
                  [capturedPlayerStartPosition, capturedPlayerId, board_id]
                );

                if (unlockedResult.affectedRows > 0) {
                  const [[unlockedPawn]] = await conn.execute(
                    `SELECT id FROM pawns 
                    WHERE player_id = ? AND board_id = ? AND type = 'main' AND current_position = ?
                    ORDER BY last_moved_at DESC LIMIT 1`,
                    [capturedPlayerId, board_id, capturedPlayerStartPosition]
                  );
                  
                  if (unlockedPawn?.id) {
                    changedPawnIds.add(unlockedPawn.id);
                  }
                }
              }
            } else {
              // Captured pawn has heart but capturing pawn doesn't - only remove heart
              const [capturedPawnUpdateResult] = await conn.execute(
                `UPDATE pawns
                    SET has_heart = 0
                  WHERE id = ?`,
                [row.id]
              );
              
              if (capturedPawnUpdateResult.affectedRows === 0) {
                throw new Error(`Failed to remove heart from pawn with id=${row.id}`);
              }
            }
            
            // Track affected players for captured pawns
            affectedPlayerIds.add(capturedPlayerId);
          }

        } catch (captureErr) {
          console.error("Error handling captured pawns:", captureErr);
          throw new Error(`Failed to handle captured pawns: ${captureErr.message}`);
        }
      }

      // 7) Insert all move logs in bulk
      try {
        const placeholders = logRows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
        await conn.execute(
          `INSERT INTO move_logs
             (board_id, player_id, pawn_id, dice_value, from_position, to_position, has_captured, got_captured, captured_pawn_ids, actual_moves, prev_move_balance, at_dice_roll_balance)
           VALUES ${placeholders}`,
          logRows.flat()
        );
      } catch (logInsertErr) {
        console.error("Error inserting move logs:", logInsertErr);
        throw new Error(`Failed to insert move logs: ${logInsertErr.message}`);
      }

      // Commit transaction
      await conn.commit();
      console.log(`Transaction committed successfully for board_id=${board_id}, pawn_id=${pawn_id}`);

    } catch (txErr) {
      // Rollback transaction on any error
      console.error("Transaction error, rolling back:", txErr);
      
      try {
        await conn.rollback();
        console.log("Transaction rolled back successfully");
      } catch (rollbackErr) {
        console.error("CRITICAL: Rollback failed:", rollbackErr);
        return safeAck({ 
          ok: false, 
          msg: "Transaction failed and rollback also failed", 
          error: txErr.message,
          rollbackError: rollbackErr.message 
        });
      }

      return safeAck({ 
        ok: false, 
        msg: "Transaction failed and was rolled back", 
        error: txErr.message 
      });

    } finally {
      // Always release the connection
      if (conn) {
        try {
          conn.release();
          console.log("Database connection released");
        } catch (releaseErr) {
          console.error("Error releasing connection:", releaseErr);
        }
      }
    }

    // -------- Build minimal delta snapshot ( AFTER successful commit ) --------
    try {
      // 1) Only fetch changed pawns (moved + captured + unlocked)
      changedPawnIds.add(pawn_id);
      if (Array.isArray(captured_pawn_ids)) {
        for (const id of captured_pawn_ids) {
          if (id) changedPawnIds.add(id);
        }
      }

      let updatedPawns = [];
      if (changedPawnIds.size > 0) {
        const pawnPlaceholders = Array.from(changedPawnIds).map(() => "?").join(", ");
        const [pawnsRows] = await db.execute(
          `SELECT 
              id, board_id, player_id, type, color, moves, moves_lost, prev_position, current_position, 
              is_safe, kills, has_heart
           FROM pawns
           WHERE id IN (${pawnPlaceholders})`,
          Array.from(changedPawnIds)
        );

        updatedPawns = pawnsRows.map((r) => ({
          id: r.id,
          board_id: r.board_id,
          player_id: r.player_id,
          type: r.type,
          color: r.color,
          prev_position: r.prev_position != null ? String(r.prev_position) : null,
          current_position: r.current_position != null ? String(r.current_position) : null,
          is_safe: Number(r.is_safe ?? 0),
          has_heart: Number(r.has_heart ?? 0),
          moves: Number(r.moves ?? 0),
          moves_lost: Number(r.moves_lost ?? 0),
          kills: Number(r.kills ?? 0),
        }));
      }

      // 2) Only fetch affected players (mover + owners of captured pawns)
      const updatedPlayers = [];
      if (affectedPlayerIds.size > 0) {
        const userIds = Array.from(affectedPlayerIds);
        const userPlaceholders = userIds.map(() => "?").join(", ");

        const [playersRows] = await db.execute(
          `
          SELECT
            u.id AS player_id,
            u.name AS playerName,
            COALESCE(pn.kills, 0)         AS kills,
            u.current_dice_roll_balance,
            u.current_move_balance,
            u.diamonds,
            '' AS teamName,
            0 AS hearts,
            0 AS spades,
            COALESCE(pn.moves, 0)         AS moves,
            COALESCE(pn.moves_lost, 0)     AS moves_lost,
            COALESCE(pn.color, '')        AS color,
            COALESCE(pn.home, 0)          AS home,
            pn.last_moved_at                AS last_moved_at,
            ''             AS activePlayerId,
            u.name AS activePlayerName,
            'user' AS activePlayerRole
          FROM boards b
          -- tie the board
          INNER JOIN users u
            ON u.id IN (b.player1, b.player2, b.player3, b.player4)

          -- aggregated pawns per player (home count + representative color + moves count + last move time)
          LEFT JOIN (
            SELECT 
              player_id, 
              board_id,
              SUM(CASE WHEN type = 'center' THEN 1 ELSE 0 END) AS home,
              SUM(kills)        AS kills,
              SUM(moves)        AS moves,
              MIN(color)        AS color,
              SUM(moves_lost)    AS moves_lost,
              MAX(last_moved_at)      AS last_moved_at
            FROM pawns
            WHERE board_id = ?
            GROUP BY player_id, board_id
          ) pn 
            ON pn.player_id = u.id 
          AND pn.board_id = b.id

          -- dice_rolls join on current_board_id + player_id
          LEFT JOIN dice_rolls dr
            ON dr.current_board_id = b.id
          AND dr.player_id       = u.id

          

          WHERE b.id = ?
            AND u.id IN (${userPlaceholders})
          ORDER BY pn.color;
          `,
          [board_id, board_id, ...userIds] 
        );

        // We'll also need board winners to compute winPosition for these players
        const [boardRows] = await db.execute(
          `SELECT winner1, winner2, winner3, loser FROM boards WHERE id = ?`,
          [board_id]
        );
        const board = boardRows[0] ?? {};

        const getWinPosition = (pid) => {
          if (board.winner1 === pid) return 1;
          if (board.winner2 === pid) return 2;
          if (board.winner3 === pid) return 3;
          if (board.loser === pid)  return 4;
          return null;
        };

        const getRank = (player_id, players) => {
          const sorted = [...players].sort((a, b) => b.moves - a.moves);
          const index = sorted.findIndex(p => p.player_id === player_id);
          return index === -1 ? null : index + 1;
        };

        for (const r of playersRows) {
          updatedPlayers.push({
            player_id: r.player_id,
            activePlayer: r.activePlayerId ? {id: r.activePlayerId, name: r.activePlayerName, role: r.activePlayerRole} : null ,
            playerName: r.playerName,
            kills: Number(r.kills ?? 0),
            current_dice_roll_balance: Number(r.current_dice_roll_balance ?? 0),
            current_move_balance: Number(r.current_move_balance ?? 0),
            moves: Number(r.moves ?? 0),
            moves_lost: Number(r.moves_lost ?? 0),
            color: r.color,
            hearts: Number(r.hearts ?? 0),
            spades: Number(r.spades ?? 0),
            home: Number(r.home ?? 0),
            teamName: r.teamName,
            diamonds: Number(r.diamonds ?? 0),
            winPosition: getWinPosition(r.player_id),
            rank: getRank(r.player_id, playersRows),
            last_moved_at: r.last_moved_at
          });
        }
      }

      // 3) Only fetch this player's dice row (we just set it to null)
      const [diceRows] = await db.execute(
        `SELECT player_id, dice_value, rolled_at 
           FROM dice_rolls 
          WHERE player_id = ?`,
        [player_id]
      );

      const updatedDice = diceRows.map((r) => ({
        player_id: r.player_id,
        dice_value: r.dice_value,
        rolled_at: r.rolled_at,
      }));

      // 4) Build delta payload
      const delta = {
        success: true,
        data: {
          board_id,
          updatedPawns,
          updatedPlayers,
          updatedDice,
          movedPawn: {
            pawn_id,
            player_id,
            prev_position: movedPawn.prev_position,
            newPosition: movedPawn.current_position,
            steps: finalMoves, // Crucial: don't blind-pass dice_value (base pawns don't move 6 squares!)
          },
        },
      };

      // Broadcast delta to the room and ACK the mover
      io.to(board_id).emit("pawnMoved", delta);
      if (finalCellId === 18 || finalCellId === 7 || finalCellId === 3) {
        await dangerZonePawnMove(io, socket, {
          board_id,
          pawn_id,
          player_id
        }, ack);
      }
      await advanceTurnAfterMove(io, board_id, player_id, dice_value);
      return safeAck({ ok: true, msg: "Move committed & broadcast", ...delta });

    } catch (snapshotErr) {
      console.error("Error building delta snapshot (transaction was committed):", snapshotErr);
      return safeAck({ 
        ok: false, 
        msg: "Move was saved but failed to build delta response", 
        error: snapshotErr.message 
      });
    }

  } catch (err) {
    console.error("Unexpected fatal error in movePawn:", err);
    return safeAck({ 
      ok: false, 
      msg: "Unexpected server error", 
      error: err.message 
    });
  }
};