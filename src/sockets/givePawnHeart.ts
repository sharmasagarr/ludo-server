import { Server } from "socket.io";
import { GameSocket } from "../types/index.js";

export const givePawnHeart = (io: Server, socket: GameSocket, db: import("@prisma/client").PrismaClient) => {
  socket.on("givePawnHeart", (payload, ack) => {
    if (typeof ack === "function") {
      ack({ ok: false, msg: "Hearts feature removed" });
    }
  });
};