import { Server } from "socket.io";
import { GameSocket } from "../types/index.js";

export const givePawnHeart = (io: Server, socket: GameSocket, db: any) => {
  socket.on("givePawnHeart", (payload, ack) => {
    if (typeof ack === "function") {
      ack({ ok: false, msg: "Hearts feature removed" });
    }
  });
};