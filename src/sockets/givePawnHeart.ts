import { Server } from "socket.io";
import { GameSocket } from "../types/index.js";

export const givePawnHeart = (_io: Server, socket: GameSocket, _db: import("@prisma/client").PrismaClient) => {
  socket.on("givePawnHeart", (_payload, ack) => {
    if (typeof ack === "function") {
      ack({ ok: false, msg: "Hearts feature removed" });
    }
  });
};