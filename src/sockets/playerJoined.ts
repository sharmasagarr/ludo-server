import prisma from "../config/prisma.js";
import { BoardStatus, CellType } from "@prisma/client";
import { recomputeTurnStateForBoard } from "./turnState.js"; 
import { mapPawnToClient, MappedPawn } from "../utils/positionMapper.js";
import { Server } from "socket.io";
import { GameSocket } from "../types/index.js";

export const playerJoined = async (io: Server, socket: GameSocket, payload: { board_id: string; player_id: string; [key: string]: unknown }, ack?: (response?: unknown) => void) => {
  const safeAck = (x: unknown) => {
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
        status: BoardStatus.active,
        players: { some: { user_id: player_id } }
      },
      include: { players: true },
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

    const playerIds = board.players.map(p => p.user_id);

    // ---- fetch pawns for this board ----
    const pawnsRaw = await prisma.pawn.findMany({
      where: { boardPlayer: { board_id } },
      include: { boardPlayer: true },
      orderBy: [{ board_player_id: 'asc' }, { id: 'asc' }]
    });
    const pawns = pawnsRaw.map(mapPawnToClient);

    // ---- fetch players aggregation ----
    let players: {
      player_id: string;
      playerName: string;
      kills: number;
      current_move_balance: number;
      diamonds: number;
      moves: number;
      moves_lost: number;
      color: string | null;
      home: number;
      last_moved_at: Date | null;
    }[] = [];
    if (playerIds.length > 0) {
      const usersInfo = await prisma.user.findMany({
        where: { id: { in: playerIds } },
        select: {
          id: true,
          name: true,
          diamonds: true
        }
      });
      // Merge with pawn stats natively
      players = usersInfo.map((u) => {
        const bp = board.players.find(p => p.user_id === u.id);
        const userPawns = pawns.filter((p: MappedPawn) => bp && p.board_player_id === bp.id);
        const homeCount = userPawns.filter((p: MappedPawn) => p.type === CellType.center).length;
        const totalKills = userPawns.reduce((sum: number, p: MappedPawn) => sum + (p.kills || 0), 0);
        const totalMoves = userPawns.reduce((sum: number, p: MappedPawn) => sum + (p.moves || 0), 0);
        const totalMovesLost = userPawns.reduce((sum: number, p: MappedPawn) => sum + (p.moves_lost || 0), 0);
        const color = userPawns.length > 0 ? (userPawns[0].color || "") : "";
        const maxMovedAt = userPawns.reduce((max: Date | null, p: MappedPawn) => p.last_moved_at && (!max || p.last_moved_at > max) ? p.last_moved_at : max, null as Date | null);

        return {
          player_id: u.id,
          playerName: u.name,
          kills: totalKills,
          current_move_balance: 0,
          diamonds: u.diamonds || 0,
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
    const diceRolls = await prisma.boardPlayer.findMany({
      where: { board_id },
      include: { user: { select: { name: true } } },
      orderBy: { rolled_at: 'desc' }
    });
    const dice_value = diceRolls.map((dr: import("@prisma/client").BoardPlayer & { user?: { name: string | null } | null }) => ({
      player_id: dr.user_id,
      name: dr.user?.name,
      dice_value: dr.dice_value,
      rolled_at: dr.rolled_at
    }));

    // ---- helper functions ----
    const getWinPosition = (pid: string) => {
      const bp = board.players.find(p => p.user_id === pid);
      if (bp && bp.rank !== null) {
        return bp.rank;
      }
      return null;
    };

    const getRank = (pid: string, playersArr: typeof players) => {
      const sorted = [...playersArr].sort((a, b) => b.moves - a.moves);
      const index = sorted.findIndex((p) => p.player_id === pid);
      return index === -1 ? null : index + 1;
    };

    // ---- socket.io room / online players handling ----

    // Get list of currently connected players BEFORE this join
    const socketsInRoom = await io.in(board_id).fetchSockets();
    const onlinePlayers = socketsInRoom.map((s) => ({
      player_id: (s as unknown as GameSocket).player_id || (s.data as any)?.player_id,
      socketId: s.id,
      joinedAt: (s as unknown as GameSocket).joinedAt || null,
    }));

    console.log(
      `Currently ${onlinePlayers.length} player(s) online in board ${board_id}`
    );

    // Join the socket to the board room
    await socket.join(board_id);
    socket.board_id = board_id;
    socket.player_id = player_id;
    socket.data = socket.data || {};
    socket.data.player_id = player_id;
    socket.data.board_id = board_id;
    (socket as GameSocket & { joinedAt?: string }).joinedAt = new Date().toISOString();

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
      playerName: players.find((player: typeof players[0]) => player.player_id === player_id)?.playerName || "Unknown", 
      turnState,
      socketId: socket.id,
      joinedAt: (socket as GameSocket & { joinedAt?: string }).joinedAt,
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
        players: players.map((r: typeof players[0]) => ({
          player_id: r.player_id,
          playerName: r.playerName,
          kills: Number(r.kills ?? 0),
          color: r.color,
          home: Number(r.home ?? 0),
          current_move_balance: Number(r.current_move_balance ?? 0),
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
  } catch (error: unknown) {
    console.error("Error in playerJoined:", error);
    return safeAck({
      ok: false,
      msg: "Failed to join game",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
