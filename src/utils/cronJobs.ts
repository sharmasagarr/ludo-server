import cron from "node-cron";
import prisma from "../config/prisma.js";
import { formatISTDateTimeForSQL, getISTDateTime } from "./istDateTime.js";

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
    // const todayStartIST = formatISTDateTimeForSQL(todayStart);
    // const todayDateIST = formatISTDateForSQL(todayStart);

    const nowStr = formatISTDateTimeForSQL();
    const expiredBoards = await prisma.board.findMany({
      where: {
        end_time: { not: null, lte: new Date(nowStr) },
        status: { not: "finished" }
      },
      include: {
        players: true
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
      const hasAllWinners = board.players.filter(p => p.rank !== null).length === 3;

      if (!hasAllWinners) {
        const boardPlayerIds = board.players.map(p => p.id);
        const moveStats = await tx.moveLog.groupBy({
          by: ['board_player_id'],
          where: { board_player_id: { in: boardPlayerIds }, actual_moves: { gt: 0 } },
          _sum: { actual_moves: true },
        });
        
        // Default 0 for anyone who hasn't moved
        const defaultStats = board.players.map(p => ({
          board_player_id: p.id,
          user_id: p.user_id,
          moves: 0
        }));

        const aggregated = defaultStats.map(ds => {
          const pm = moveStats.find(x => x.board_player_id === ds.board_player_id);
          return {
            ...ds,
            moves: Number(pm?._sum?.actual_moves) || 0
          };
        });

        // Sort players by moves (descending)
        const sortedPlayers = [...aggregated].sort((a, b) => b.moves - a.moves);

        // Determine winners and loser (ranks)
        const endTimeIST = new Date(formatISTDateTimeForSQL());
        
        for (let i = 0; i < sortedPlayers.length; i++) {
          const agg = sortedPlayers[i];
          const rank = i < 3 ? i + 1 : 4;
          const is_looser = (i === sortedPlayers.length - 1);
          
          await tx.boardPlayer.update({
            where: { id: agg.board_player_id },
            data: { rank, is_looser }
          });
        }

        // Update board status and end_time
        await tx.board.update({
          where: { id: board.id },
          data: {
            status: "finished",
            end_time: endTimeIST
          }
        });

        console.log(
          `[Cron Job] Board ${board.id} finished logically based on moves.`
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

