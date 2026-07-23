import db from "../config/db.js";
import { canPlayerAct, recomputeTurnStateForBoard, advanceTurnAfterMove, startTurnTimer } from "./turnState.js"; 
import handleFinalPos from "../utils/handleFinalPos.js";

export const rollDice = async (io, socket, payload, ack) => {
  const safeAck = (x) => { try { ack?.(x); } catch {} };

  let conn = null;
  try {
    const { board_id, player_id } = payload ?? {};

    // 🎲 Securely generate dice roll on the backend (1-6)
    const dice_value = Math.floor(Math.random() * 6) + 1;
    // const dice_value = 1;

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
    const [existingRolls] = await db.execute(
      `SELECT dice_value FROM dice_rolls WHERE player_id = ? AND dice_value IS NOT NULL`,
      [player_id]
    );
    if (existingRolls.length > 0) {
      return safeAck({ ok: false, msg: "You must spend your active dice roll before rolling again." });
    }

    // Notify clients that player started rolling
    io.to(board_id).emit("playerStartedRolling", {
      board_id,
      player_id,
      timestamp: new Date().toISOString()
    });

    // get a transaction connection
    conn = await db.getConnection();
    await conn.beginTransaction();

    // If dice is not 6, decrement the player's current_dice_roll_balance
    if (dice_value !== 6) {
      await conn.execute(
        `UPDATE users 
         SET current_dice_roll_balance = GREATEST(COALESCE(current_dice_roll_balance,0) - 1, 0)
         WHERE id = ?`,
        [player_id]
      );
    }

    // Determine valid_moves completely on the backend
    const [playerPawns] = await conn.execute(
      `SELECT current_position, color, type FROM pawns WHERE board_id = ? AND player_id = ?`,
      [board_id, player_id]
    );

    let valid_moves = false;
    let validPawnIds = [];
    for (const pawn of playerPawns) {
      if (pawn.current_position === 'finished' || pawn.type === 'center') continue;
      const moveResult = handleFinalPos(pawn.current_position, dice_value, pawn.color, pawn.type);
      if (moveResult && !moveResult.error) {
        valid_moves = true;
        validPawnIds.push(pawn.id);
      }
    }

    // Store the roll in dice_rolls and dice_roll_logs
    await conn.execute(
      `INSERT INTO dice_rolls (player_id, current_board_id, dice_value, rolled_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE current_board_id = VALUES(current_board_id), dice_value = VALUES(dice_value), rolled_at = NOW()`,
      [player_id, board_id, dice_value]
    );
    
    await conn.execute(
      `INSERT INTO dice_roll_logs (board_id, player_id, dice_value, valid_moves, rolled_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [board_id, player_id, dice_value, JSON.stringify(valid_moves)]
    );

    // Retrieve all players' dice for this board
    const [allPlayers] = await conn.execute(
      `SELECT 
         p.player_id,
         u.name,
         dr.dice_value,
         dr.rolled_at
       FROM (
         SELECT id as board_id, player1 as player_id FROM boards WHERE id = ?
         UNION ALL
         SELECT id as board_id, player2 as player_id FROM boards WHERE id = ?
         UNION ALL
         SELECT id as board_id, player3 as player_id FROM boards WHERE id = ? AND player3 IS NOT NULL
         UNION ALL
         SELECT id as board_id, player4 as player_id FROM boards WHERE id = ? AND player4 IS NOT NULL
       ) p
       INNER JOIN users u ON p.player_id = u.id
       LEFT JOIN dice_rolls dr ON dr.player_id = p.player_id
       ORDER BY dr.rolled_at DESC`,
      [board_id, board_id, board_id, board_id]
    );

    // Commit the transaction
    await conn.commit();

    // Build base roll result
    const rollResult = {
      board_id,
      player_id,
      dice_value,
      isAllPawnsLocked: valid_moves === false, // for client animation timing
      allPlayersDice: allPlayers.map(p => ({
        player_id: p.player_id,
        playerName: p.name,
        dice_value: p.dice_value,
        rolled_at: p.rolled_at,
        isDiceRolling: p.player_id === player_id // only rolling player has animation
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
              to: (room) => io.to(room),
              emit: () => {} 
            };
            
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
      await conn.execute(
        `INSERT INTO dice_rolls (player_id, current_board_id, dice_value, rolled_at)
         VALUES (?, ?, NULL, NOW())
         ON DUPLICATE KEY UPDATE current_board_id = VALUES(current_board_id), dice_value = NULL, rolled_at = NOW()`,
        [player_id, board_id]
      );

      // Get updated dice state after clearing
      const [updatedPlayers] = await conn.execute(
        `SELECT 
           p.player_id,
           u.name,
           dr.dice_value,
           dr.rolled_at
         FROM (
           SELECT id as board_id, player1 as player_id FROM boards WHERE id = ?
           UNION ALL
           SELECT id as board_id, player2 as player_id FROM boards WHERE id = ?
           UNION ALL
           SELECT id as board_id, player3 as player_id FROM boards WHERE id = ? AND player3 IS NOT NULL
           UNION ALL
           SELECT id as board_id, player4 as player_id FROM boards WHERE id = ? AND player4 IS NOT NULL
         ) p
         INNER JOIN users u ON p.player_id = u.id
         LEFT JOIN dice_rolls dr ON dr.player_id = p.player_id
         ORDER BY dr.rolled_at DESC`,
        [board_id, board_id, board_id, board_id]
      );

      const clearResult = {
        board_id,
        player_id,
        dice_value: null,
        allPlayersDice: updatedPlayers.map(p => ({
          player_id: p.player_id,
          playerName: p.name,
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

  } catch (err) {
    // Rollback transaction
    try {
      if (conn) await conn.rollback();
    } catch (rbErr) {
      console.error("Rollback failed:", rbErr);
    }

    console.error("Error in rollDice:", err);
    return safeAck({
      ok: false,
      msg: "Failed to roll dice",
      error: err.message
    });
  } finally {
    if (conn) {
      try {
        conn.release();
      } catch (releaseErr) {
        console.error("Error releasing DB connection:", releaseErr);
      }
    }
  }
};