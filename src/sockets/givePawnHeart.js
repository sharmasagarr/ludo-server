export const givePawnHeart = (io, socket, db) => {
  socket.on("givePawnHeart", (payload, ack) => {
    if (typeof ack === "function") {
      ack({ ok: false, msg: "Hearts feature removed" });
    }
  });
};