import { Pawn, CellType, Color, BoardPlayer } from "@prisma/client";

export const posToStr = (area: number | null | undefined, cell: number | null | undefined): string | null => {
  if (area === null || area === undefined || cell === null || cell === undefined) return null;
  return `cell-area-${area}-id-${cell}`;
}

export const strToPos = (pos: string | null | undefined): { area: number | null, cell: number | null } => {
  if (!pos || pos === "finished") return { area: null, cell: null };
  const match = pos.match(/cell-area-(\d+)-id-(\d+)/);
  if (match) {
    return { area: parseInt(match[1]), cell: parseInt(match[2]) };
  }
  return { area: null, cell: null };
}

export interface MappedPawn extends Omit<Pawn, 'cell_type'> {
  type: CellType;
  color?: Color | null;
  board_id?: string;
  player_id?: string;
  current_position: string | null;
  prev_position: string | null;
  next_position: string | null;
  boardPlayer?: undefined; // Explicitly removed
}

export type PawnWithBoardPlayer = Pawn & { boardPlayer?: BoardPlayer | null };

export const mapPawnToClient = (pawn: PawnWithBoardPlayer): MappedPawn => {
  return {
    ...pawn,
    type: pawn.cell_type,
    color: pawn.boardPlayer?.color,
    board_id: pawn.boardPlayer?.board_id,
    player_id: pawn.boardPlayer?.user_id,
    current_position: pawn.cell_type === CellType.center ? "finished" : posToStr(pawn.current_area, pawn.current_cell),
    prev_position: pawn.cell_type === CellType.center ? "finished" : posToStr(pawn.prev_area, pawn.prev_cell),
    next_position: pawn.cell_type === CellType.center ? "finished" : posToStr(pawn.next_area, pawn.next_cell),
    // Strip nested sensitive DB fields if necessary or leave them
    boardPlayer: undefined,
  } as MappedPawn;
}
