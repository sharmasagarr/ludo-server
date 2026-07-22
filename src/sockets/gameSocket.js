import { playerJoined } from "./playerJoined.js";
import { rollDice } from "./rollDice.js";
import { movePawn } from "./movePawn.js";
import { recomputeTurnStateForBoard } from "./turnState.js";
import { givePawnHeart } from "./givePawnHeart.js";
import jwt from "jsonwebtoken";

export default function gameSocket (io) {
    // Socket Authentication Middleware
    io.use((socket, next) => {
        try {
            // Support both socket.auth payload (frontend) and Authorization header (Postman)
            const token = socket.handshake.auth?.token || 
                         (socket.handshake.headers?.authorization && socket.handshake.headers.authorization.split(" ")[1]);

            if (!token) {
                return next(new Error("Authentication Error: Missing Token"));
            }

            const decoded = jwt.verify(token, process.env.JWT_SECRET || "supersecretkey");
            socket.user = decoded; // Attach user info to socket
            next();
        } catch (err) {
            return next(new Error("Authentication Error: Invalid or Expired Token"));
        }
    });

    io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on("joinGame", (arg1, arg2) => {
        const ack = typeof arg1 === "function" ? arg1 : arg2;
        const payload = { player_id: socket.user.id };
        playerJoined(io, socket, payload, ack);
    });

    socket.on("rollDice", (payload, ack) => {
        payload.player_id = socket.user.id;
        rollDice(io, socket, payload, ack);
    });

    socket.on("movePawn", (payload, ack) => {
        payload.player_id = socket.user.id;
        movePawn(io, socket, payload, ack);
    });

    socket.on("givePawnHeart", (payload, ack) => {
        payload.player_id = socket.user.id;
        givePawnHeart(io, socket, payload, ack);
    });

    // Handle disconnection
    socket.on("disconnect", async  () => {
        if (socket.board_id) {
            // Notify others that player left
            socket.to(socket.board_id).emit("playerLeft", {
                board_id: socket.board_id,
                player_id: socket.player_id,
                socketId: socket.id
            });
            
            console.log(`Player ${socket.player_id} left board ${socket.board_id}`);
            // Recompute turn state after someone leaves
            try {
                await recomputeTurnStateForBoard(io, socket.board_id);
            } catch (err) {
                console.error("Error recomputing turn state on disconnect:", err);
            }
        }
    });

    socket.on("disconnecting", () => {
        // This fires before the socket leaves rooms
        const rooms = Array.from(socket.rooms);
        console.log(`Socket ${socket.id} is leaving rooms:`, rooms);
    });
    })
}