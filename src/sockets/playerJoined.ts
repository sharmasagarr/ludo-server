import prisma from "../config/prisma.js";
import { recomputeTurnStateForBoard } from "./turnState.js"; 
import { Server } from "socket.io";
import { GameSocket } from "../types/index.js";

export const playerJoined = async (io: Server, socket: GameSocket, payload: any, ack?: any) => {
  const safeAck = (x: any) => {
    try {
      ack?.(x);
    } catch {}
  };

  try {
    const { player_id } = payload ?? {};

    // ---- validation ----
    if (!player_id) {
      console.error("Validation error: Missing required fields", { player_id });
      return safeAck({
        ok: false,
        msg: "Missing required fields: player_id",
      });
    }

    // ---- fetch active board for this player ----
    const activeBoard = await prisma.board.findFirst({
      where: {
        status: "active",
        OR: [
          { player1: player_id },
          { player2: player_id },
          { player3: player_id },
          { player4: player_id },
        ]
      },
      orderBy: [
        { start_time: 'desc' },
        { id: 'desc' },
      ]
    });

    if (!activeBoard) {
      return safeAck({
        ok: false,
        msg: "Active board not found for this user",
      });
    }

    const board = activeBoard;
    const board_id = board.id;

    const playerIds = [
      board.player1,
      board.player2,
      board.player3,
      board.player4,
    ].filter((pid): pid is string => !!pid && pid !== "");

    // ---- fetch pawns for this board ----
    const pawns = await prisma.pawn.findMany({
      where: { board_id },
      orderBy: [{ player_id: 'asc' }, { id: 'asc' }]
    });

    // ---- fetch players aggregation ----
    let players: any[] = [];
    if (playerIds.length > 0) {
      const usersInfo = await prisma.user.findMany({
        where: { id: { in: playerIds } },
        select: {
          id: true,
          name: true,
          current_dice_roll_balance: true,
          current_move_balance: true,
          diamonds: true
        }
      });
      // Merge with pawn stats natively
      players = usersInfo.map((u: any) => {
        const userPawns = pawns.filter((p: any) => p.player_id === u.id);
        const homeCount = userPawns.filter((p: any) => p.type === 'center').length;
        const totalKills = userPawns.reduce((sum: number, p: any) => sum + (p.kills || 0), 0);
        const totalMoves = userPawns.reduce((sum: number, p: any) => sum + (p.moves || 0), 0);
        const totalMovesLost = userPawns.reduce((sum: number, p: any) => sum + (p.moves_lost || 0), 0);
        const color = userPawns.length > 0 ? userPawns[0].color : "";
        const maxMovedAt = userPawns.reduce((max: Date | null, p: any) => p.last_moved_at && (!max || p.last_moved_at > max) ? p.last_moved_at : max, null as Date | null);

        return {
          player_id: u.id,
          playerName: u.name,
          kills: totalKills,
          current_dice_roll_balance: u.current_dice_roll_balance,
          current_move_balance: u.current_move_balance,
          diamonds: u.diamonds,
          moves: totalMoves,
          moves_lost: totalMovesLost,
          color,
          home: homeCount,
          last_moved_at: maxMovedAt
        };
      });
      
      players.sort((a, b) => String(a.color || "").localeCompare(String(b.color || "")));
    }

    // ---- fetch dice values for this board ----
    const diceRolls = await prisma.diceRoll.findMany({
      where: { current_board_id: board_id },
      include: { player: { select: { name: true } } },
      orderBy: { rolled_at: 'desc' }
    });
    const dice_value = diceRolls.map((dr: any) => ({
      player_id: dr.player_id,
      name: dr.player.name,
      dice_value: dr.dice_value,
      rolled_at: dr.rolled_at
    }));

    // ---- helper functions ----
    const getWinPosition = (pid: string) => {
      if (board.winner1 === pid) return 1;
      if (board.winner2 === pid) return 2;
      if (board.winner3 === pid) return 3;
      if (board.loser === pid) return 4;
      return null; // Game still in progress
    };

    const getRank = (pid: string, playersArr: any[]) => {
      const sorted = [...playersArr].sort((a, b) => b.moves - a.moves);
      const index = sorted.findIndex((p) => p.player_id === pid);
      return index === -1 ? null : index + 1;
    };

    // ---- socket.io room / online players handling ----

    // Get list of currently connected players BEFORE this join
    const socketsInRoom = await io.in(board_id).fetchSockets();
    const onlinePlayers = socketsInRoom.map((s) => ({
      player_id: (s as unknown as GameSocket).player_id,
      socketId: s.id,
      joinedAt: (s as unknown as GameSocket).joinedAt || null,
    }));

    console.log(
      `Currently ${onlinePlayers.length} player(s) online in board ${board_id}`
    );

    // Join the socket to the board room
    await socket.join(board_id);
    (socket as any).board_id = board_id;
    (socket as any).player_id = player_id;
    (socket as any).joinedAt = new Date().toISOString();

    console.log(
      `Player ${player_id} joined board ${board_id} with socket ${socket.id}`
    );

    // Get updated room info
    const room = io.sockets.adapter.rooms.get(board_id);
    const roomSize = room ? room.size : 0;

    console.log(`Room ${board_id} now has ${roomSize} player(s)`);

    const turnState = await recomputeTurnStateForBoard(io, board_id);

    // Notify others in the room (excluding the sender)
    socket.to(board_id).emit("playerJoined", {
      board_id,
      player_id,
      playerName: players.find((player: any) => player.player_id === player_id)?.playerName || "Unknown", 
      turnState,
      socketId: socket.id,
      joinedAt: (socket as any).joinedAt,
      message: `Player ${player_id} has joined the game`,
      totalPlayers: roomSize,
    });

    // Broadcast room update to all players in the room
    io.to(board_id).emit("roomUpdate", {
      board_id,
      playerCount: roomSize,
      turnState,
      timestamp: new Date().toISOString(),
    });

    // ---- ACK to the joining client with full data ----
    safeAck({
      ok: true,
      board_id,
      player_id,
      socketId: socket.id,
      msg: "Successfully joined game",
      onlinePlayers,
      totalPlayers: roomSize,
      turnState,
      data: {
        board_id: board.id,
        players: players.map((r: any) => ({
          player_id: r.player_id,
          playerName: r.playerName,
          kills: Number(r.kills ?? 0),
          color: r.color,
          home: Number(r.home ?? 0),
          current_dice_roll_balance: Number(r.current_dice_roll_balance ?? 0),
          moves: Number(r.moves ?? 0),
          moves_lost: Number(r.moves_lost ?? 0),
          diamonds: Number(r.diamonds ?? 0),
          winPosition: getWinPosition(r.player_id),
          rank: getRank(r.player_id, players),
          last_moved_at: r.last_moved_at,
        })),
        dice_value,
        pawns,
      },
    });
  } catch (error: any) {
    console.error("Error in playerJoined:", error);
    return safeAck({
      ok: false,
      msg: "Failed to join game",
      error: error.message,
    });
  }
};
