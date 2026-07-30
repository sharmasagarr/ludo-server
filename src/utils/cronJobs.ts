import cron from "node-cron";
import prisma from "../config/prisma.js";
import { formatISTDateTimeForSQL, formatISTDateForSQL, getISTDateTime } from "./istDateTime.js";

/**
 * Check and finish expired boards based on end_time
 * Runs daily at 12:00 AM IST
 */
export const checkExpiredBoards = async (): Promise<void> => {
  try {
    console.log(`[Cron Job] Checking expired boards at ${formatISTDateTimeForSQL()}`);

    const now = getISTDateTime();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayStartIST = formatISTDateTimeForSQL(todayStart);
    const todayDateIST = formatISTDateForSQL(todayStart);

    const nowStr = formatISTDateTimeForSQL();
    const expiredBoards = await prisma.board.findMany({
      where: {
        end_time: { not: null, lte: new Date(nowStr) },
        status: { not: "finished" }
      }
    });

    if (expiredBoards.length === 0) {
      console.log(`[Cron Job] No expired boards found`);
      return;
    }

    console.log(`[Cron Job] Found ${expiredBoards.length} expired board(s)`);

    await prisma.$transaction(async (tx: import("@prisma/client").Prisma.TransactionClient) => {

    for (const board of expiredBoards) {
      // Check if board already has all winners set
      const hasAllWinners = board.winner1 && board.winner2 && board.winner3;

      if (!hasAllWinners) {
        // Get all players for this board
        const players = [
          board.player1,
          board.player2,
          board.player3,
          board.player4,
        ].filter((p): p is string => !!p);

        // Calculate total moves earned for each player on this board from move_logs
        const playerMoves = await tx.moveLog.groupBy({
          by: ['player_id'],
          where: { board_id: board.id, actual_moves: { gt: 0 } },
          _sum: { actual_moves: true },
          orderBy: { _sum: { actual_moves: 'desc' } }
        });

        // Create a map of player_id to moves
        const movesMap = new Map();
        for (const pm of playerMoves) {
          movesMap.set(pm.player_id, Number(pm._sum.actual_moves) || 0);
        }

        // Ensure all players are in the map (with 0 moves if no moves logged)
        for (const player_id of players) {
          if (!movesMap.has(player_id)) {
            movesMap.set(player_id, 0);
          }
        }

        // Sort players by moves (descending)
        const sortedPlayers = players
          .map(player_id => ({
            player_id,
            moves: movesMap.get(player_id) || 0,
          }))
          .sort((a, b) => b.moves - a.moves);

        // Determine winners and loser
        let winner1 = null;
        let winner2 = null;
        let winner3 = null;
        let loser = null;

        if (sortedPlayers.length >= 1) {
          winner1 = sortedPlayers[0].player_id;
        }
        if (sortedPlayers.length >= 2) {
          winner2 = sortedPlayers[1].player_id;
        }
        if (sortedPlayers.length >= 3) {
          winner3 = sortedPlayers[2].player_id;
        }
        if (sortedPlayers.length >= 4) {
          loser = sortedPlayers[3].player_id;
        } else if (sortedPlayers.length === 3) {
          // For 3 players, the one with least moves is loser
          loser = sortedPlayers[2].player_id;
        } else if (sortedPlayers.length === 2) {
          // For 2 players, the one with least moves is loser
          loser = sortedPlayers[1].player_id;
        }

        // Update board with winners, loser, status, and end_time
        const endTimeIST = new Date(formatISTDateTimeForSQL());
        await tx.board.update({
          where: { id: board.id },
          data: {
            winner1,
            winner2,
            winner3,
            loser,
            status: "finished",
            end_time: endTimeIST
          }
        });

        console.log(
          `[Cron Job] Board ${board.id} finished: Winner1=${winner1}, Winner2=${winner2}, Winner3=${winner3}, Loser=${loser}`
        );
      } else {
        // Board already has winners, just mark as finished
        const endTimeIST = new Date(formatISTDateTimeForSQL());
        await tx.board.update({
          where: { id: board.id },
          data: { status: "finished", end_time: endTimeIST }
        });

      console.log(`[Cron Job] Board ${board.id} marked as finished (winners already set)`);
      }
    }
  });
  console.log(`[Cron Job] Successfully processed ${expiredBoards.length} expired board(s)`);
  } catch (error) {
    console.error("[Cron Job] Error checking expired boards:", error);
  }
};

/**
 * Start the cron job to check expired boards daily at 12:00 AM IST
 * 
 * IMPORTANT: node-cron uses the server's local timezone.
 * - If server is in IST: use "0 0 * * *" (runs at 00:00 IST)
 * - If server is in UTC: use "30 18 * * *" (runs at 18:30 UTC = 00:00 IST next day)
 * 
 * However, the checkExpiredBoards function uses getISTDateTime() which always
 * returns IST time regardless of server timezone, so the date comparison logic
 * will work correctly. The only issue is the cron schedule timing.
 * 
 * To make it work regardless of server timezone, we calculate the IST time
 * and schedule accordingly. But since node-cron doesn't support timezone directly,
 * we need to manually calculate the UTC equivalent.
 * 
 * Better approach: Use a timezone-aware scheduling or check the server timezone
 * and adjust the cron expression accordingly.
 */
export const startExpiredBoardsCron = (): void => {
  // Detect server timezone offset
  const serverOffset = -new Date().getTimezoneOffset() / 60; // Offset in hours
  const istOffset = 5.5; // IST is UTC+5:30
  
  let cronExpression;
  let scheduleDescription;
  
  if (serverOffset === istOffset) {
    // Server is in IST
    cronExpression = "0 0 * * *"; // Every day at midnight IST
    scheduleDescription = "Daily at 12:00 AM IST (server is in IST)";
  } else {
    // Server is in UTC or other timezone
    // 12:00 AM IST = 18:30 UTC (previous day)
    // But we need to account for the server's timezone
    // If server is UTC: 18:30 UTC = 18:30 server time
    // If server is in another timezone, calculate accordingly
    
    // For UTC servers: 12:00 AM IST = 18:30 UTC (previous day)
    // Cron: 30 18 * * * means "at 18:30 server time"
    // If server is UTC, this is correct
    // If server is not UTC, we need to adjust
    
    if (serverOffset === 0) {
      // Server is in UTC
      cronExpression = "30 18 * * *"; // Every day at 18:30 UTC = 00:00 IST next day
      scheduleDescription = "Daily at 12:00 AM IST (18:30 UTC, server is in UTC)";
    } else {
      // Server is in another timezone - calculate the equivalent time
      // 12:00 AM IST = 18:30 UTC
      // We need to convert 18:30 UTC to server's local time
      const utcHour = 18;
      const utcMinute = 30;
      const serverHour = (utcHour - serverOffset + 24) % 24;
      const serverMinute = utcMinute;
      
      cronExpression = `${serverMinute} ${serverHour} * * *`;
      scheduleDescription = `Daily at 12:00 AM IST (calculated for server timezone UTC${serverOffset >= 0 ? '+' : ''}${serverOffset})`;
      
      console.warn(`[Cron Job] Server timezone is UTC${serverOffset >= 0 ? '+' : ''}${serverOffset}, not IST or UTC.`);
      console.warn(`[Cron Job] Cron expression adjusted to: ${cronExpression}`);
    }
  }
  
  console.log("[Cron Job] Starting expired boards checker");
  console.log(`[Cron Job] Schedule: ${scheduleDescription}`);
  console.log(`[Cron Job] Cron expression: ${cronExpression}`);
  console.log(`[Cron Job] Server timezone offset: UTC${serverOffset >= 0 ? '+' : ''}${serverOffset}`);

  cron.schedule(cronExpression, async () => {
    console.log(`[Cron Job] Scheduled run triggered at ${formatISTDateTimeForSQL()}`);
    await checkExpiredBoards();
  });

  // Run immediately on startup for testing/debugging (optional - can be removed in production)
  // Uncomment the line below to test the cron job immediately
  // checkExpiredBoards();
};

