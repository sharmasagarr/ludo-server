export default function handleCapture(movedPawn, allPawnsAfterMove){
    let has_captured = 0;
    let occupants = []
    let captured_pawn_ids = [];
    let kills = 0;
    const SAFE_IDS = new Set([14, 4]);
    const parts = movedPawn.current_position.split("-");
    const cellNum = Number.parseInt(parts[4], 10);

    const canCaptureHere = (() => {
      if (movedPawn.type === "center" || movedPawn.type === "home") return false;
      return !SAFE_IDS.has(cellNum);
    })();

    if (canCaptureHere) {
        occupants = allPawnsAfterMove
        .filter(p => 
          p.type === "main" &&
          p.current_position === movedPawn.current_position &&
          p.color !== movedPawn.color
        );

      if (occupants.length > 0) {
        has_captured = 1
        occupants.forEach((occ) => {
          if (!occ.has_heart){
            kills += 1;
          } else if(movedPawn.has_heart && occ.has_heart){
            kills += 1;
          }
          captured_pawn_ids.push(occ.id);
        });
      }
    }
    return {has_captured, captured_pawn_ids, kills}
}