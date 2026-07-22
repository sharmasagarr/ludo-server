import db from "../config/db.js";
import { recomputeTurnStateForBoard } from "./turnState.js"; 

export const playerJoined = async (io, socket, payload, ack) => {
  const safeAck = (x) => {
    try {
      ack?.(x);
    } catch {}
  };

  let connection = null;

  try {
    connection = await db.getConnection();

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
    const [boardRows] = await connection.execute(
      `SELECT * FROM boards 
       WHERE status = 'active'
         AND (player1 = ? OR player2 = ? OR player3 = ? OR player4 = ?)
       ORDER BY start_time DESC, id DESC
       LIMIT 1`,
      [player_id, player_id, player_id, player_id]
    );

    if (boardRows.length === 0) {
      return safeAck({
        ok: false,
        msg: "Active board not found for this user",
      });
    }

    const board = boardRows[0];
    const board_id = board.id;

    const playerIds = [
      board.player1,
      board.player2,
      board.player3,
      board.player4,
    ].filter((pid) => pid && pid !== "");

    // ---- fetch pawns for this board ----
    const [pawns] = await connection.execute(
      `SELECT * FROM pawns WHERE board_id = ? ORDER BY player_id, id`,
      [board.id]
    );

    // ---- fetch players aggregation ----
    let players = [];

    if (playerIds.length > 0) {
      const [playersRows] = await connection.execute(
        `SELECT
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
        LEFT JOIN users u
          ON u.id IN (b.player1, b.player2, b.player3, b.player4)

        -- aggregated pawns per player (home count + representative color + moves count)
        LEFT JOIN (
          SELECT 
            player_id, 
            board_id,
            SUM(CASE WHEN type = 'center' THEN 1 ELSE 0 END) AS home,
            SUM(kills)        AS kills,
            SUM(moves)        AS moves,
            MIN(color)        AS color,
            SUM(moves_lost)    AS moves_lost,
            MAX(last_moved_at)  AS last_moved_at
          FROM pawns
          WHERE board_id = ?
          GROUP BY player_id, board_id
        ) pn ON pn.player_id = u.id AND pn.board_id = b.id

        -- dice_rolls join on current_board_id + player_id
        LEFT JOIN dice_rolls dr
          ON dr.current_board_id = b.id
         AND dr.player_id       = u.id

        

        WHERE b.id = ?
        ORDER BY pn.color`,
        [board.id, board.id]
      );

      players = playersRows;
    }

    // ---- fetch dice values for this board ----
    let dice_value = [];
    [dice_value] = await connection.execute(
      `SELECT
        p.player_id,
        u.name,
        dice_value,
        dr.rolled_at
      FROM (
        -- Unpivot the player columns into rows
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
      [board.id, board.id, board.id, board.id]
    );

    // ---- helper functions ----
    const getWinPosition = (pid) => {
      if (board.winner1 === pid) return 1;
      if (board.winner2 === pid) return 2;
      if (board.winner3 === pid) return 3;
      if (board.loser === pid) return 4;
      return null; // Game still in progress
    };

    const getRank = (pid, playersArr) => {
      const sorted = [...playersArr].sort((a, b) => b.moves - a.moves);
      const index = sorted.findIndex((p) => p.player_id === pid);
      return index === -1 ? null : index + 1;
    };

    // ---- socket.io room / online players handling ----

    // Get list of currently connected players BEFORE this join
    const socketsInRoom = await io.in(board_id).fetchSockets();
    const onlinePlayers = socketsInRoom.map((s) => ({
      player_id: s.player_id,
      socketId: s.id,
      joinedAt: s.joinedAt || null,
    }));

    console.log(
      `Currently ${onlinePlayers.length} player(s) online in board ${board_id}`
    );

    // Join the socket to the board room
    await socket.join(board_id);
    socket.board_id = board_id;
    socket.player_id = player_id;
    socket.joinedAt = new Date().toISOString();

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
      playerName: players.find((player) => player.player_id === player_id).playerName, 
      teamName: players.find((player) => player.player_id === player_id).teamName,
      turnState,
      socketId: socket.id,
      joinedAt: socket.joinedAt,
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
        players: players.map((r) => ({
          player_id: r.player_id,
          activePlayer: r.activePlayerId
            ? {
                id: r.activePlayerId,
                name: r.activePlayerName,
                role: r.activePlayerRole,
              }
            : null,
          playerName: r.playerName,
          kills: Number(r.kills ?? 0),
          color: r.color,
          home: Number(r.home ?? 0),
          hearts: Number(r.hearts ?? 0),
          spades: Number(r.spades ?? 0),
          teamName: r.teamName,
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
  } catch (error) {
    console.error("Error in playerJoined:", error);
    return safeAck({
      ok: false,
      msg: "Failed to join game",
      error: error.message,
    });
  } finally {
    if (connection) {
      try {
        connection.release();
      } catch (e) {
        console.error("Error releasing connection:", e);
      }
    }
  }
};
