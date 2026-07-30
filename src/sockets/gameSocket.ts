import { playerJoined } from "./playerJoined.js";
import { rollDice } from "./rollDice.js";
import { movePawn } from "./movePawn.js";
import { recomputeTurnStateForBoard } from "./turnState.js";
import { givePawnHeart } from "./givePawnHeart.js";
import { suspendGame } from "./suspendGame.js";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { GameSocket, AuthenticatedUser } from "../types/index.js";

export default function gameSocket(io: Server) {
    // Socket Authentication Middleware
    io.use((socket: GameSocket, next) => {
        const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(" ")[1];
        
        if (!token) {
            return next(new Error("Authentication error: No token provided"));
        }

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || "supersecretkey") as AuthenticatedUser;
            socket.user = decoded; // Attach user payload
            next();
        } catch (err) {
            return next(new Error("Authentication Error: Invalid or Expired Token"));
        }
    });

    io.on("connection", (socket: GameSocket) => {
        console.log(`Socket connected: ${socket.id}`);

        const wrapPayload = <T extends Record<string, unknown>>(payload: T) => ({
            ...(payload || {}),
            player_id: (payload && typeof payload === 'object' && 'player_id' in payload ? payload.player_id : socket.user?.id) as string
        } as T & { player_id: string });

        // Register handlers, passing io and socket context along with the ack function
        socket.on("joinGame", (payload, ack) => playerJoined(io, socket, wrapPayload(payload), ack));
        socket.on("rollDice", (payload, ack) => rollDice(io, socket, wrapPayload(payload), ack));
        socket.on("movePawn", (payload, ack) => movePawn(io, socket, wrapPayload(payload), ack));
        socket.on("givePawnHeart", (payload) => givePawnHeart(io, socket, wrapPayload(payload)));
        socket.on("suspendGame", (payload, ack) => suspendGame(io, socket, wrapPayload(payload), ack));

        socket.on("disconnect", async () => {
            console.log(`Socket disconnected: ${socket.id}`);
            
            if (socket.board_id && socket.player_id) {
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
                    console.error("Error recompute turn state on disconnect:", err);
                }
            }
        });

        socket.on("disconnecting", () => {
            // This fires before the socket leaves rooms
            const rooms = Array.from(socket.rooms);
            console.log(`Socket ${socket.id} is leaving rooms:`, rooms);
        });
    });
}