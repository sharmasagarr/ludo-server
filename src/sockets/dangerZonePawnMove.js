import db from "../config/db.js";
import handleDangerZoneMove from "../utils/handleDangerZoneMove.js";


export const dangerZonePawnMove = async (io, socket, payload, ack) => {
  const safeAck = (x) => { try { ack?.(x); } catch {} };
  let conn = null;


  try {
    const { board_id, pawn_id, player_id } = payload ?? {};


    if (!board_id || !pawn_id || !player_id) {
      console.error("Missing required fields", { board_id, pawn_id, player_id });
      return safeAck({
        ok: false,
        msg: "Missing required fields: board_id, pawn_id, or player_id",
      });
    }


    try {
      conn = await db.getConnection();
    } catch (connErr) {
      console.error("DB connection error:", connErr);
      return safeAck({
        ok: false,
        msg: "Failed to establish database connection",
        error: connErr.message,
      });
    }


    try {
      await conn.beginTransaction();


      // 1) Load pawn + its FLM
      const [[pawnRow]] = await conn.execute(
        `SELECT * FROM pawns WHERE id = ? AND board_id = ?`,
        [pawn_id, board_id]
      );


      if (!pawnRow) {
        await conn.rollback();
        return safeAck({ ok: false, msg: "Pawn not found for this board" });
      }


      if (pawnRow.player_id !== player_id) {
        await conn.rollback();
        return safeAck({ ok: false, msg: "You cannot move this pawn" });
      }


      const [[flmBeforeMove]] = await conn.execute(
        `SELECT current_dice_roll_balance, current_move_balance, kills, id
           FROM users
          WHERE id = ?`,
        [player_id]
      );


      if (!flmBeforeMove) {
        await conn.rollback();
        return safeAck({ ok: false, msg: "FLM row not found" });
      }


      // 2) Apply danger zone movement
      const { newPosition, moves_lost } = handleDangerZoneMove(
        pawnRow.current_position,
        pawnRow.color
      );


      // No danger? bail out gracefully
      if (
        moves_lost <= 0 ||
        !newPosition ||
        newPosition === pawnRow.current_position
      ) {
        await conn.rollback();
        return safeAck({
          ok: true,
          msg: "No danger-zone move applied",
          data: null,
        });
      }


      // Track affected player IDs for FLM updates
      const affectedPlayerIds = new Set([player_id]);
      const changedPawnIds = new Set([pawn_id]);


      // 3) Update pawn going backwards
      await conn.execute(
        `UPDATE pawns 
           SET prev_position = ?,
               current_position = ?,
               moves = GREATEST(moves - ?, 0),
               moves_lost = moves_lost + ?,
               last_moved_at = NOW()
         WHERE id = ?`,
        [
          String(pawnRow.current_position ?? ""),
          String(newPosition),
          moves_lost,
          moves_lost,
          pawn_id,
        ]
      );


      // 4) Update FLM of the player who lost moves
      await conn.execute(
        `UPDATE users
            SET current_move_balance = GREATEST(current_move_balance - ?, 0)
          WHERE id = ?`,
        [moves_lost, player_id]
      );


      // 5) Re-fetch pawns AFTER backward move to check for collision
      const [pawnsAfterMove] = await conn.execute(
        `SELECT * FROM pawns WHERE board_id = ?`,
        [board_id]
      );
      const backwardPawn = pawnsAfterMove.find((p) => p.id === pawn_id);

      // ===== CAPTURE LOGIC FOR DANGER-ZONE BACKWARD MOVE =====
      let has_captured = false;
      let captured_pawn_ids = [];
      let kills = 0;
      let captureLogs = [];


      // Find any pawn already on that cell, different color/player, not base/center
      const capturerPawn = pawnsAfterMove.find(
        (p) =>
          p.current_position === backwardPawn.current_position &&
          p.id !== pawn_id &&
          p.player_id !== backwardPawn.player_id && // opponent
          p.type !== "base" &&
          p.type !== "center" &&
          Number(p.is_safe) !== 1
      );


      if (capturerPawn) {
        // Add capturer player to affected players
        affectedPlayerIds.add(capturerPawn.player_id);


        // In this scenario:
        //  - capturerPawn = pawn that was already there
        //  - backwardPawn = pawn that moved back and gets captured


        const capturedPawn = backwardPawn;
        const capturedPlayerId = capturedPawn.player_id;
        const capturedFromPos = String(capturedPawn.current_position ?? "0");


        // get FLM rows of capturer and captured
        const [[capturedFlmBefore]] = await conn.execute(
          `SELECT current_dice_roll_balance, current_move_balance
             FROM users
            WHERE id = ?`,
          [capturedPlayerId]
        );


        has_captured = true;
        captured_pawn_ids = [capturedPawn.id];
        kills = 1;


        if (capturedPawn.has_heart !== 1) {
          // 🟥 Standard capture: send backward pawn to base


          // a) reset captured pawn to base
          const [capturedPawnUpdateResult] = await conn.execute(
            `UPDATE pawns
                SET type = 'base',
                    prev_position = ?,
                    current_position = '0',
                    moves_lost = moves_lost + ?,
                    moves = 0,
                    is_safe = 1,
                    has_heart = 0
              WHERE id = ?`,
            [capturedFromPos, capturedPawn.moves, capturedPawn.id]
          );


          // b) capturer pawn gains those moves
          const [capturerPawnUpdateResult] = await conn.execute(
            `UPDATE pawns
                SET moves = moves + ?
              WHERE id = ?`,
            [capturedPawn.moves, capturerPawn.id]
          );


          // c) captured FLM loses move balance
          const [capturedFlmUpdateResult] = await conn.execute(
            `UPDATE users
                SET current_move_balance = GREATEST(current_move_balance - ?, 0)
              WHERE id = ?`,
            [capturedPawn.moves, capturedPlayerId]
          );


          // d) capturer FLM gains moves + move balance + kills + dice bonus
          const [capturerFlmUpdateResult] = await conn.execute(
            `UPDATE users
                SET current_move_balance = current_move_balance + ?,
                    kills = kills + ?,
                    current_dice_roll_balance = current_dice_roll_balance + 1
              WHERE id = ?`,
            [capturedPawn.moves, kills, capturerPawn.player_id]
          );


          if (
            capturedPawnUpdateResult.affectedRows === 0 ||
            capturerPawnUpdateResult.affectedRows === 0 ||
            capturedFlmUpdateResult.affectedRows === 0 ||
            capturerFlmUpdateResult.affectedRows === 0
          ) {
            throw new Error(
              `Failed to reset captured pawn or update FLMs for danger-zone capture`
            );
          }


          // e) log for captured pawn (similar to movePawn "got_captured" log)
          const movesLostLog = -Math.abs(capturedPawn.moves);
          captureLogs.push([
            board_id,
            capturedPlayerId,
            capturedPawn.id,
            null, // dice_value
            capturedFromPos,
            "0",
            0, // has_captured
            1, // got_captured
            null, // captured_pawn_ids
            movesLostLog,
            capturedFlmBefore.current_move_balance,
            capturedFlmBefore.current_dice_roll_balance,
          ]);

          // 🔥 NEW: Auto-unlock logic for captured player in danger zone
          // Check if all their pawns are now in base (no main pawns)
          const [[capturedPlayerStatus]] = await conn.execute(
            `SELECT 
              NOT EXISTS (SELECT 1 FROM pawns WHERE player_id = ? AND board_id = ? AND type = 'main') as noMainPawns,
              EXISTS (SELECT 1 FROM pawns WHERE player_id = ? AND board_id = ? AND type = 'base') as hasBasePawns
            `,
            [capturedPlayerId, board_id, capturedPlayerId, board_id]
          );

          // If captured player has no main pawns AND has base pawns, unlock one
          if (capturedPlayerStatus.noMainPawns === 1 && capturedPlayerStatus.hasBasePawns === 1) {
            // Get the start position for this captured player's color
            const homeAreaIdByColor = {
              blue: 1,
              red: 2,
              green: 3,
              yellow: 4,
            };
            const capturedPlayerStartPosition = `cell-area-${homeAreaIdByColor[capturedPawn.color]}-id-14`;

            const [unlockedResult] = await conn.execute(
              `UPDATE pawns 
              SET type = 'main', prev_position = '0', current_position = ?, last_moved_at = NOW()
              WHERE player_id = ? AND board_id = ? AND type = 'base'
              LIMIT 1`,
              [capturedPlayerStartPosition, capturedPlayerId, board_id]
            );

            if (unlockedResult.affectedRows > 0) {
              // Get the unlocked pawn to add to changedPawnIds
              const [[unlockedPawn]] = await conn.execute(
                `SELECT id FROM pawns 
                WHERE player_id = ? AND board_id = ? AND type = 'main' AND current_position = ?
                ORDER BY last_moved_at DESC LIMIT 1`,
                [capturedPlayerId, board_id, capturedPlayerStartPosition]
              );
              
              if (unlockedPawn?.id) {
                changedPawnIds.add(unlockedPawn.id);
                console.log(`🔓 Auto-unlocked pawn ${unlockedPawn.id} for captured player ${capturedPlayerId} in danger zone`);
              }
            }
          }
        } else {
          // 🟨 Pawn had a heart → only remove heart, keep it in place
          const [capturedPawnUpdateResult] = await conn.execute(
            `UPDATE pawns
                SET has_heart = 0
              WHERE id = ?`,
            [capturedPawn.id]
          );


          if (capturedPawnUpdateResult.affectedRows === 0) {
            throw new Error(
              `Failed to remove heart from pawn with id=${capturedPawn.id}`
            );
          }


          // No got_captured log row in this branch (optional: you can add one if you like)
        }


        // f) update kills for capturer pawn
        const [pawnKillUpdate] = await conn.execute(
          `UPDATE pawns
              SET kills = kills + ?
            WHERE id = ?`,
          [kills, capturerPawn.id]
        );


        if (pawnKillUpdate.affectedRows === 0) {
          throw new Error(
            `Failed to update kills for capturer pawn_id=${capturerPawn.id}`
          );
        }

        // Add capturer pawn to changed pawns
        changedPawnIds.add(capturerPawn.id);
        
        // Track affected players for captured pawns
        affectedPlayerIds.add(capturedPlayerId);
      }


      // ===== END CAPTURE BLOCK =====


      // 6) Create moveLog for the backward move itself
      const logRows = [
        [
          board_id,
          player_id,
          pawn_id,
          null, // dice_value: this move is from danger, not direct dice click
          String(pawnRow.current_position ?? null),
          String(newPosition ?? null),
          0, // has_captured (this pawn didn't capture anyone)
          has_captured ? 1 : 0, // got_captured? maybe yes if capturer captured it immediately
          has_captured ? JSON.stringify(captured_pawn_ids) : null,
          -moves_lost, // actual_moves: negative because you lost progress
          flmBeforeMove.current_move_balance,
          flmBeforeMove.current_dice_roll_balance,
        ],
        ...captureLogs,
      ];


      if (logRows.length) {
        const placeholders = logRows
          .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .join(", ");
        await conn.execute(
          `INSERT INTO move_logs
             (board_id, player_id, pawn_id, dice_value, from_position, to_position, has_captured, got_captured, captured_pawn_ids, actual_moves, prev_move_balance, at_dice_roll_balance)
           VALUES ${placeholders}`,
          logRows.flat()
        );
      }


      await conn.commit();


      // ========= Build & broadcast delta =========
      // changedPawnIds already includes: pawn_id, captured_pawn_ids, capturerPawn.id, and any unlocked pawn


      let updatedPawns = [];
      if (changedPawnIds.size > 0) {
        const pawnPlaceholders = Array.from(changedPawnIds)
          .map(() => "?")
          .join(", ");
        const [pawnsRows] = await conn.execute(
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
          prev_position: String(r.prev_position ?? ""),
          current_position: String(r.current_position ?? ""),
          is_safe: Number(r.is_safe ?? 0),
          has_heart: Number(r.has_heart ?? 0),
          moves: Number(r.moves ?? 0),
          moves_lost: Number(r.moves_lost ?? 0),
          kills: Number(r.kills ?? 0),
        }));
      }


      // Fetch updated FLM data for all affected players
      let updatedPlayers = [];
      if (affectedPlayerIds.size > 0) {
        const playerPlaceholders = Array.from(affectedPlayerIds)
          .map(() => "?")
          .join(", ");
        const [flmRows] = await db.execute(
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
            AND u.id IN (${playerPlaceholders})
          ORDER BY pn.color;


          `,
          [board_id, board_id, ...Array.from(affectedPlayerIds)] 
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
          // players: array of objects -> { player_id, moves }


          // Sort players by moves DESC (higher moves = better rank)
          const sorted = [...players].sort((a, b) => b.moves - a.moves);


          // Find the index of this player in sorted list
          const index = sorted.findIndex(p => p.player_id === player_id);


          return index === -1 ? null : index + 1; // Rank starts from 1
        };


        updatedPlayers = flmRows.map((r) => ({
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
          rank: getRank(r.player_id, flmRows),
          last_moved_at: r.last_moved_at
        }));
      }
      
      const movedPawn = updatedPawns.find((pawn) => pawn.id === pawn_id);


      const delta = {
        success: true,
        data: {
          board_id,
          updatedPawns,
          updatedPlayers,
          updatedDice: [],
          movedPawn: {
            pawn_id,
            player_id,
            prev_position: movedPawn?.prev_position || "",
            newPosition: movedPawn?.current_position || "",
            steps: -moves_lost,
          },
        },
      };


      io.to(board_id).emit("pawnMoved", delta);
      return safeAck({ ok: true, msg: "Danger move + capture handled", ...delta });
    } catch (txErr) {
      console.error("Danger-zone tx error:", txErr);
      try {
        await conn.rollback();
      } catch (rbErr) {
        console.error("Rollback failed:", rbErr);
      }
      return safeAck({
        ok: false,
        msg: "Danger-zone transaction failed",
        error: txErr.message,
      });
    } finally {
      if (conn) {
        try {
          conn.release();
        } catch {}
      }
    }
  } catch (err) {
    console.error("Fatal error in handleDangerZonePawnMove:", err);
    return safeAck({
      ok: false,
      msg: "Unexpected server error",
      error: err.message,
    });
  }
};
