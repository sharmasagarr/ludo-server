import db from "../config/db.js";

const boardTurnState = {};
const boardTurnTimers = {};
let handleTurnTimeout;

export const recomputeTurnStateForBoard = async (io, board_id, shouldBroadcast = true) => {
  if (!board_id) return;

  // 1) find online players in this board (from sockets)
  const socketsInRoom = await io.in(board_id).fetchSockets();
  const onlineIds = new Set(
  socketsInRoom
      .map((s) => s.player_id)
      .filter(Boolean)
  );

  // 2) get dice balance of all players of this board
  const [rows] = await db.execute(
      `
      SELECT u.id AS player_id,
        COALESCE(u.current_dice_roll_balance, 0) AS current_dice_roll_balance
      FROM boards b
      JOIN users u
        ON u.id IN (b.player1, b.player2, b.player3, b.player4)
      WHERE b.id = ?
      `,
      [board_id]
  );

  const activeTurnPlayers = rows
      .filter(
          (r) =>
          r.player_id &&
          onlineIds.has(r.player_id)
      )
      .map((r) => r.player_id);

  let mode;
  let currentTurnPlayerId;
  let turnOrder = [];

  const prevState = boardTurnState[board_id];

  if (activeTurnPlayers.length >= 2) {
  mode = "turn";
  turnOrder = activeTurnPlayers;

  if (
      prevState &&
      prevState.currentTurnPlayerId &&
      activeTurnPlayers.includes(prevState.currentTurnPlayerId)
  ) {
      currentTurnPlayerId = prevState.currentTurnPlayerId;
  } else {
      currentTurnPlayerId = activeTurnPlayers[0];
  }
  } else {
  // Less than 2 players: game is waiting, nobody can act
  mode = "waiting";
  turnOrder = activeTurnPlayers;
  currentTurnPlayerId = null;
  }

  const timerNonce = Date.now();
  boardTurnState[board_id] = { mode, currentTurnPlayerId, turnOrder, timerNonce };

  if (currentTurnPlayerId) {
    try {
      const [balRows] = await db.execute(
        `SELECT current_dice_roll_balance FROM users WHERE id = ?`,
        [currentTurnPlayerId]
      );
      if (balRows[0] && Number(balRows[0].current_dice_roll_balance) < 1) {
        await db.execute(
          `UPDATE users SET current_dice_roll_balance = 1 WHERE id = ?`,
          [currentTurnPlayerId]
        );
        // Force an update to the connected players to unlock their UI
        io.to(board_id).emit("playerStatsUpdated", [
            { player_id: currentTurnPlayerId, current_dice_roll_balance: 1 }
        ]);
      }
    } catch (e) {
      console.error("Error replenishing balance on reconnect:", e);
    }
  }

  if (shouldBroadcast) {
    io.to(board_id).emit("turnStateUpdate", {
      board_id,
      mode,
      currentTurnPlayerId,
      turnOrder,
      timerNonce,
    });
  }

  // ⬇️ TIMER SUPPORT
  if (mode !== "turn") {
    // waiting mode => no timer
    clearTurnTimer(board_id);
  } else {
    const turnChanged =
      !prevState ||
      prevState.mode !== "turn" ||
      prevState.currentTurnPlayerId !== currentTurnPlayerId;

    if (turnChanged) {
      startTurnTimer(io, board_id);
    }
  }

  return boardTurnState[board_id];
};

handleTurnTimeout = async (io, board_id) => {
  const state = boardTurnState[board_id];
  if (!state || state.mode !== "turn") return;

  const { currentTurnPlayerId, turnOrder } = state;
  if (!currentTurnPlayerId || !turnOrder || turnOrder.length === 0) {
    clearTurnTimer(board_id);
    return;
  }

  const timedOutPlayerId = currentTurnPlayerId;
  // console.log(`⏰ Turn timed out for player ${timedOutPlayerId} on board ${board_id}`);

  // 🛑 0) ANTI-CHEAT: FORCED AUTO-MOVE
  // If the player holds an active dice roll and has valid moves, force them to move!
  try {
    const [diceRows] = await db.execute(
      `SELECT dice_value FROM dice_rolls WHERE player_id = ? AND current_board_id = ? AND dice_value IS NOT NULL`,
      [timedOutPlayerId, board_id]
    );

    if (diceRows.length > 0) {
      const pendingDiceValue = diceRows[0].dice_value;

      const [playerPawns] = await db.execute(
        `SELECT id, current_position, color, type FROM pawns WHERE board_id = ? AND player_id = ?`,
        [board_id, timedOutPlayerId]
      );

      const { default: handleFinalPos } = await import("../utils/handleFinalPos.js");
      let validPawns = [];

      for (const pawn of playerPawns) {
        if (pawn.current_position === 'finished' || pawn.type === 'center') continue;
        const currPos = pawn.current_position; 
        const moveResult = handleFinalPos(currPos, pendingDiceValue, pawn.color, pawn.type);
        if (moveResult && !moveResult.error) {
           validPawns.push(pawn.id);
        }
      }

      // If they had legal moves, they were intentionally dodging! Force move.
      if (validPawns.length > 0) {
        const forcedPawnId = validPawns[Math.floor(Math.random() * validPawns.length)];
        console.log(`[ANTI-CHEAT] Auto-forcing AFK move for player ${timedOutPlayerId} pawn ${forcedPawnId}`);
        
        const { movePawn } = await import('./movePawn.js');
        const mockSocket = {
          id: 'SERVER_AFK_AUTO',
          board_id: board_id, // ensure payload spoof passes validation
          player_id: timedOutPlayerId,
          to: (room) => io.to(room),
          emit: () => {} // stub
        };

        // Suppress errors during auto-move to ensure server continuity
        try {
          await movePawn(io, mockSocket, {
            board_id,
            pawn_id: forcedPawnId,
            player_id: timedOutPlayerId
          }, () => {});
        } catch (autoErr) {
          console.error("Auto-move failed, falling back to wipe:", autoErr);
        }

        // movePawn automatically processes advanceTurnAfterMove natively!
        return; 
      }
    }
  } catch (err) {
    console.error("Failed to process auto-move intercept:", err);
  }

  // 🛑 1) NO VALID MOVES: CLEAR DICE IN DB FOR TIMED OUT PLAYER
  try {
    await db.execute(
      `INSERT INTO dice_rolls (player_id, current_board_id, dice_value, rolled_at)
       VALUES (?, ?, NULL, NOW())
       ON DUPLICATE KEY UPDATE current_board_id = VALUES(current_board_id), dice_value = NULL, rolled_at = NOW()`,
      [timedOutPlayerId, board_id]
    );

    // Fetch refreshed players dice row to broadcast (as seen in rollDice auto-clear)
    const [updatedPlayers] = await db.execute(
      `SELECT 
         p.player_id, u.name, dr.dice_value, dr.rolled_at
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

    io.to(board_id).emit("diceCleared", {
      board_id,
      player_id: timedOutPlayerId,
      dice_value: null,
      allPlayersDice: updatedPlayers.map(p => ({
        player_id: p.player_id,
        playerName: p.name,
        dice_value: p.dice_value,
        rolled_at: p.rolled_at
      }))
    });
  } catch (err) {
    console.error("Failed to clear dice on timeout:", err);
  }

  // Compute next player in order
  let idx = turnOrder.indexOf(currentTurnPlayerId);
  if (idx === -1) idx = 0;
  const nextIdx = (idx + 1) % turnOrder.length;
  const nextPlayerId = turnOrder[nextIdx];

  const timerNonce = Date.now();
  state.currentTurnPlayerId = nextPlayerId;
  state.timerNonce = timerNonce;
  boardTurnState[board_id] = state;

  // Notify clients that we auto-skipped someone
  io.to(board_id).emit("turnTimedOut", {
    board_id,
    timedOutPlayerId,
    nextPlayerId,
  });

  // And send updated turn state
  io.to(board_id).emit("turnStateUpdate", {
    board_id,
    mode: state.mode,
    currentTurnPlayerId: state.currentTurnPlayerId,
    turnOrder: state.turnOrder,
    timerNonce: state.timerNonce,
  });

  // Start timer for the next player
  startTurnTimer(io, board_id);
};


export const canPlayerAct = async (io, board_id, player_id) => {
  if (!board_id || !player_id) {
    return { ok: false, reason: "INVALID_DATA" };
  }

  if (!boardTurnState[board_id]) {
    await recomputeTurnStateForBoard(io, board_id);
  }
  const state = boardTurnState[board_id];

  const [[row]] = await db.execute(
    `SELECT COALESCE(current_dice_roll_balance, 0) AS balance
     FROM users
     WHERE id = ?`,
    [player_id]
  );

  const balance = Number(row?.balance ?? 0);

  if (balance <= 0) {
    return { ok: false, reason: "NO_BALANCE" };
  }

  if (!state || state.mode === "waiting") {
    return { ok: false, reason: "WAITING_FOR_PLAYERS" };
  }

  if (state.currentTurnPlayerId !== player_id) {
    return { ok: false, reason: "NOT_YOUR_TURN" };
  }

  return { ok: true, reason: "TURN_OK" };
};

export const advanceTurnAfterMove = async (io, board_id, lastPlayerId, dice_value) => {
  console.log(`[DEBUG] advanceTurnAfterMove called | player: ${lastPlayerId} | dice_value: ${dice_value} | Number(dice): ${Number(dice_value)}`);
  if (!board_id || !lastPlayerId) return;

  // Pass false to prevent a redundant broadcast just for reading the state
  const state = await recomputeTurnStateForBoard(io, board_id, false);
  if (!state || state.mode !== "turn") {
    clearTurnTimer(board_id); // no strict turn
    return;
  }

  const { turnOrder } = state;
  if (turnOrder.length === 0) {
    clearTurnTimer(board_id);
    return;
  }

  if (Number(dice_value) === 6 && turnOrder.includes(lastPlayerId)) {
    state.currentTurnPlayerId = lastPlayerId;
  } else {
    let idx = turnOrder.indexOf(lastPlayerId);
    if (idx === -1) idx = 0;
    const nextIdx = (idx + 1) % turnOrder.length;
    state.currentTurnPlayerId = turnOrder[nextIdx];
  }

  // Ensure the incoming turn player has a dice roll balance of 1 so their client UI unlocks
  if (state.currentTurnPlayerId) {
    try {
      await db.execute(
        `UPDATE users SET current_dice_roll_balance = 1 WHERE id = ?`,
        [state.currentTurnPlayerId]
      );
      
      // Broadcast updated players (including dice balance) so frontends unlock their UI dice
      const [updatedPlayers] = await db.execute(
        `SELECT 
           u.id as player_id,
           u.name as playerName,
           COALESCE(u.current_dice_roll_balance, 0) as current_dice_roll_balance,
           COALESCE(u.current_move_balance, 0) as current_move_balance,
           pn.color
         FROM (
           SELECT player_id, board_id FROM pawns WHERE board_id = ? GROUP BY player_id, board_id
         ) p
         INNER JOIN users u ON p.player_id = u.id
         LEFT JOIN (
           SELECT player_id, MIN(color) as color FROM pawns WHERE board_id = ? GROUP BY player_id
         ) pn ON pn.player_id = p.player_id`,
        [board_id, board_id]
      );

      const parsedPlayers = updatedPlayers.map(p => ({
        ...p,
        current_dice_roll_balance: Number(p.current_dice_roll_balance ?? 0),
        current_move_balance: Number(p.current_move_balance ?? 0),
      }));

      io.to(board_id).emit("playerStatsUpdated", parsedPlayers);
      
    } catch (err) {
      console.error("Failed to replenish dice roll balance:", err);
    }
  }

  const timerNonce = Date.now();
  state.timerNonce = timerNonce;
  boardTurnState[board_id] = state;

  io.to(board_id).emit("turnStateUpdate", {
    board_id,
    mode: state.mode,
    currentTurnPlayerId: state.currentTurnPlayerId,
    turnOrder: state.turnOrder,
    timerNonce: state.timerNonce,
  });

  // ⬇️ NEW: start 30s timer for whoever now has the turn
  startTurnTimer(io, board_id);
};

export const clearTurnTimer = (board_id) => {
  const existing = boardTurnTimers[board_id];
  if (existing) {
    clearTimeout(existing);
    delete boardTurnTimers[board_id];
  }
};

// Start (or restart) a 30s timer for the current turn player
export const startTurnTimer = (io, board_id) => {
  clearTurnTimer(board_id);

  // 🛑 TEMPORARILY DISABLED FOR TESTING/DEVELOPMENT
  // return;

  const state = boardTurnState[board_id];
  if (!state || state.mode !== "turn" || !state.currentTurnPlayerId) return;

  const timerMs = (Number(process.env.TURN_TIMER_SECONDS) || 30) * 1000;
  boardTurnTimers[board_id] = setTimeout(() => {
    handleTurnTimeout(io, board_id);
  }, timerMs);
};