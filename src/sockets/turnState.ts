import type { GameSocket } from "../types/index.js";
import prisma from "../config/prisma.js";
import { Server } from "socket.io";

import { mapPawnToClient } from "../utils/positionMapper.js";

interface TurnState {
  mode: string;
  currentTurnPlayerId: string | null;
  turnOrder: string[];
  timerNonce: number;
}

const boardTurnState: Record<string, TurnState> = {};
const boardTurnTimers: Record<string, NodeJS.Timeout> = {};
let handleTurnTimeout: (io: Server, board_id: string) => Promise<void>;

export const recomputeTurnStateForBoard = async (io: Server, board_id: string, shouldBroadcast: boolean = true, _skipBalanceReplenish: boolean = false) => {
  if (!board_id) return;

  // 1) find online players in this board (from sockets)
  const socketsInRoom = await io.in(board_id).fetchSockets();
  const onlineIds = new Set(
  socketsInRoom
      .map((s) => (s as unknown as GameSocket).player_id)
      .filter(Boolean)
  );

  // 2) get dice balance of all players of this board
  const board = await prisma.board.findUnique({
    where: { id: board_id },
    include: { players: { orderBy: { seat_number: 'asc' } } }
  });

  if (!board) return;

  const playerIds = board.players.map(p => p.user_id);

  const activeTurnPlayers = playerIds.filter((pid: string) => onlineIds.has(pid));

  let mode: string;
  let currentTurnPlayerId: string | null = null;
  let turnOrder: string[] = [];

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

handleTurnTimeout = async (io: Server, board_id: string) => {
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
    const bp = await prisma.boardPlayer.findUnique({
      where: { board_id_user_id: { board_id, user_id: timedOutPlayerId } }
    });

    if (bp && bp.dice_value !== null && bp.dice_value !== undefined) {
      const pendingDiceValue = bp.dice_value;
      
      const playerPawnsRaw = await prisma.pawn.findMany({
        where: { board_player_id: bp.id },
        include: { boardPlayer: true }
      });
      const playerPawns = playerPawnsRaw.map(mapPawnToClient);

      const { default: handleFinalPos } = await import("../utils/handleFinalPos.js");
      let validPawns = [];

      for (const pawn of playerPawns) {
        if (pawn.current_position === 'finished' || pawn.type === 'center') continue;
        const currPos = pawn.current_position || "0"; 
        const moveResult = handleFinalPos(currPos, Number(pendingDiceValue || 0), String(pawn.color || "red"), String(pawn.type));
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
          to: (room: string) => io.to(room),
          emit: () => {} // stub
        } as unknown as GameSocket;

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

  // 🛑 1) NO VALID MOVES:          // Clear dice row (set to null) instead of deleting
  try {
    await prisma.boardPlayer.update({
      where: { board_id_user_id: { board_id, user_id: timedOutPlayerId } },
      data: { dice_value: null, rolled_at: new Date() }
    });

    // Fetch refreshed players dice row to broadcast (as seen in rollDice auto-clear)
    const diceRolls = await prisma.boardPlayer.findMany({
      where: { board_id },
      include: { user: { select: { name: true } } },
      orderBy: { rolled_at: 'desc' }
    });

    const updatedPlayers = diceRolls.map((dr: import("@prisma/client").BoardPlayer & { user?: { name: string | null } | null }) => ({
      player_id: dr.user_id,
      name: dr.user?.name,
      dice_value: dr.dice_value,
      rolled_at: dr.rolled_at
    }));

    const sockets = await io.in(board_id).fetchSockets();

    io.to(board_id).emit("diceCleared", {
      board_id,
      player_id: timedOutPlayerId,
      dice_value: null,
      allPlayersDice: updatedPlayers.map((p: typeof updatedPlayers[0]) => {
        const s = sockets.find(s => (s as unknown as GameSocket).player_id === p.player_id);
        return {
          player_id: p.player_id,
          socketId: s?.id,
          playerName: p.name,
          dice_value: p.dice_value,
          rolled_at: p.rolled_at
        };
      })
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


export const canPlayerAct = async (io: Server, board_id: string, player_id: string) => {
  if (!board_id || !player_id) {
    return { ok: false, reason: "INVALID_DATA" };
  }

  if (!boardTurnState[board_id]) {
    await recomputeTurnStateForBoard(io, board_id);
  }
  const state = boardTurnState[board_id];



  if (!state || state.mode === "waiting") {
    return { ok: false, reason: "WAITING_FOR_PLAYERS" };
  }

  if (state.currentTurnPlayerId !== player_id) {
    return { ok: false, reason: "NOT_YOUR_TURN" };
  }

  return { ok: true, reason: "TURN_OK" };
};

export const advanceTurnAfterMove = async (io: Server, board_id: string, lastPlayerId: string, dice_value: number | null) => {
  console.log(`[DEBUG] advanceTurnAfterMove called | player: ${lastPlayerId} | dice_value: ${dice_value} | Number(dice): ${Number(dice_value)}`);
  if (!board_id || !lastPlayerId) return;

  // Pass false to prevent a redundant broadcast just for reading the state
  const state = await recomputeTurnStateForBoard(io, board_id, false, true); // pass true to skipBalanceReplenish
  if (!state || state.mode !== "turn") {
    clearTurnTimer(board_id); // no strict turn
    return;
  }

  const { turnOrder } = state;
  if (turnOrder.length === 0) {
    clearTurnTimer(board_id);
    return;
  }

  // If you rolled a 6, you keep the turn!
  if ((Number(dice_value) === 6) && turnOrder.includes(lastPlayerId)) {
    state.currentTurnPlayerId = lastPlayerId;
  } else {
    let idx = turnOrder.indexOf(lastPlayerId);
    if (idx === -1) idx = 0;
    const nextIdx = (idx + 1) % turnOrder.length;
    state.currentTurnPlayerId = turnOrder[nextIdx];
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

export const clearTurnTimer = (board_id: string) => {
  const existing = boardTurnTimers[board_id];
  if (existing) {
    clearTimeout(existing);
    delete boardTurnTimers[board_id];
  }
};

// Start (or restart) a 30s timer for the current turn player
export const startTurnTimer = (io: Server, board_id: string) => {
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