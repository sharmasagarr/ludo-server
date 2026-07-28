import type { GameSocket } from "../types/index.js";
import prisma from "../config/prisma.js";
import { Server } from "socket.io";

const boardTurnState: Record<string, any> = {};
const boardTurnTimers: Record<string, any> = {};
let handleTurnTimeout: any;

export const recomputeTurnStateForBoard = async (io: Server, board_id: string, shouldBroadcast: boolean = true) => {
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
    where: { id: board_id }
  });

  if (!board) return;

  const playerIds = [board.player1, board.player2, board.player3, board.player4].filter((pid): pid is string => !!pid);

  const users = await prisma.user.findMany({
    where: { id: { in: playerIds } },
    select: { id: true, current_dice_roll_balance: true }
  });

  const rows = users.map((u: any) => ({
    player_id: u.id,
    current_dice_roll_balance: Number(u.current_dice_roll_balance || 0)
  }));

  const activeTurnPlayers = rows
      .filter(
          (r: any) =>
          r.player_id &&
          onlineIds.has(r.player_id)
      )
      .map((r: any) => r.player_id);

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

  if (currentTurnPlayerId) {
    try {
      const u = await prisma.user.findUnique({ where: { id: currentTurnPlayerId } });
      
      if (u && Number(u.current_dice_roll_balance || 0) < 1) {
        await prisma.user.update({
          where: { id: currentTurnPlayerId },
          data: { current_dice_roll_balance: 1 }
        });
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
    const diceRoll = await prisma.diceRoll.findFirst({
      where: {
        player_id: timedOutPlayerId,
        current_board_id: board_id,
        dice_value: { not: null }
      }
    });

    if (diceRoll) {
      const pendingDiceValue = diceRoll.dice_value;

      const playerPawns = await prisma.pawn.findMany({
        where: { board_id, player_id: timedOutPlayerId },
        select: { id: true, current_position: true, color: true, type: true }
      });

      const { default: handleFinalPos } = await import("../utils/handleFinalPos.js");
      let validPawns = [];

      for (const pawn of playerPawns) {
        if (pawn.current_position === 'finished' || pawn.type === 'center') continue;
        const currPos = pawn.current_position || "0"; 
        const moveResult = handleFinalPos(currPos, Number(pendingDiceValue || 0), String(pawn.color || "red") as any, pawn.type as any);
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
    await prisma.diceRoll.upsert({
      where: { player_id: timedOutPlayerId },
      update: {
        current_board_id: board_id,
        dice_value: null,
        rolled_at: new Date()
      },
      create: {
        player_id: timedOutPlayerId,
        current_board_id: board_id,
        dice_value: null,
        rolled_at: new Date()
      }
    });

    // Fetch refreshed players dice row to broadcast (as seen in rollDice auto-clear)
    const diceRolls = await prisma.diceRoll.findMany({
      where: { current_board_id: board_id },
      include: { player: { select: { name: true } } },
      orderBy: { rolled_at: 'desc' }
    });

    const updatedPlayers = diceRolls.map((dr: any) => ({
      player_id: dr.player_id,
      name: dr.player.name,
      dice_value: dr.dice_value,
      rolled_at: dr.rolled_at
    }));

    const sockets = await io.in(board_id).fetchSockets();

    io.to(board_id).emit("diceCleared", {
      board_id,
      player_id: timedOutPlayerId,
      dice_value: null,
      allPlayersDice: updatedPlayers.map((p: any) => {
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

  const u = await prisma.user.findUnique({
    where: { id: player_id },
    select: { current_dice_roll_balance: true }
  });

  const balance = Number(u?.current_dice_roll_balance ?? 0);

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

export const advanceTurnAfterMove = async (io: Server, board_id: string, lastPlayerId: string, dice_value: number | null) => {
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
      await prisma.user.update({
        where: { id: state.currentTurnPlayerId },
        data: { current_dice_roll_balance: 1 }
      });
      
      const board = await prisma.board.findUnique({ where: { id: board_id } });
      if (!board) return;
      const playerIds = [board.player1, board.player2, board.player3, board.player4].filter((pid): pid is string => !!pid);

      const users = await prisma.user.findMany({
        where: { id: { in: playerIds } },
        select: {
          id: true,
          name: true,
          current_dice_roll_balance: true,
          current_move_balance: true,
        }
      });
      
      const pawns = await prisma.pawn.findMany({
        where: { board_id }
      });

      const parsedPlayers = users.map((u: any) => {
        const userPawns = pawns.filter((p: any) => p.player_id === u.id);
        const color = userPawns.length > 0 ? userPawns[0].color : "";
        return {
          player_id: u.id,
          playerName: u.name,
          current_dice_roll_balance: Number(u.current_dice_roll_balance ?? 0),
          current_move_balance: Number(u.current_move_balance ?? 0),
          color
        };
      });

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