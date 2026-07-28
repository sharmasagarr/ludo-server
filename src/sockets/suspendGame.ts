import prisma from "../config/prisma.js";
import { recomputeTurnStateForBoard } from "./turnState.js";
import { Server } from "socket.io";
import { GameSocket } from "../types/index.js";

export const suspendGame = async (io: Server, socket: GameSocket, payload: any, ack: any) => {
  const { board_id, player_id } = payload;
  
  if (!board_id || !player_id) {
    if (ack) ack({ success: false, message: "Missing board_id or player_id" });
    return;
  }

  try {
    // 1) Delete all pawns to permanently disqualify the player
    await prisma.pawn.deleteMany({
      where: { board_id, player_id }
    });
    
    // 2) Wipe their dice roll if they had a pending one
    await prisma.diceRoll.updateMany({
      where: { player_id, current_board_id: board_id },
      data: { dice_value: null }
    });

    // 3) Broadcast leaving visually to other players
    io.to(board_id).emit("playerLeft", {
       board_id,
       player_id,
       socketId: socket.id
    });

    // 4) Recompute turn state completely so their turn is skipped globally
    await recomputeTurnStateForBoard(io, board_id);
    console.log(`[SUSPEND] Player ${player_id} forfeited board ${board_id} and all pawns wiped.`);

    if (ack) {
      ack({ success: true, message: "Game suspended. You have left the board." });
    }
  } catch (error) {
    console.error("Error suspending game:", error);
    if (ack) {
      ack({ success: false, message: "Internal server error" });
    }
  }
};
