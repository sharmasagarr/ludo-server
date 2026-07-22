export default function handleFinalPos(
    current_position,
    dice_value,
    color,
    type
) {
  let finalPosition;
  let finalType;
  let finalCellNum;
  let is_safe = 0;
  let moves = 0;

  const AREAS = 4;
  const MAX_ID_PER_AREA = 18;
  const SAFE_IDS = new Set([14, 4]);

  const homeAreaIdByColor = {
    blue: 1,
    red: 2,
    green: 3,
    yellow: 4,
  };

  const startPosition = `cell-area-${homeAreaIdByColor[color]}-id-14`;

  // ===== helper to build position string =====
  const toCell = ({ areaId, cellNum }) => {
    if (cellNum === null || areaId === null) return "finished";
    return `cell-area-${areaId}-id-${cellNum}`;
  };

  // ===== clean up legacy DB strings =====
  if (current_position === "null" || current_position === "undefined") {
    current_position = null;
  }

  // ===== parse current_position for main / home =====
  let areaId = null;
  let cellNum = null;

  if (current_position && current_position !== "0") {
    const parts = current_position.split("-");
    areaId = Number.parseInt(parts[2], 10);
    cellNum = Number.parseInt(parts[4], 10);
  }

  const stepForward = ({ areaId, cellNum }) => {
    if (areaId == null || cellNum == null) {
      return { areaId: null, cellNum: null };
    }
    let nextCellNum;
    let nextAreaId = areaId;

    if (cellNum === 7 && areaId !== homeAreaIdByColor[color]) {
      // jump from 7 → 13 for non-home areas
      nextCellNum = 13;
    } else if (cellNum === 12) {
      // reach center
      nextCellNum = null;
    } else {
      nextCellNum = cellNum + 1;
    }

    if (nextCellNum === null) {
      return { areaId: null, cellNum: null };
    }

    if (nextCellNum > MAX_ID_PER_AREA) {
      nextCellNum = 1;
      nextAreaId = (areaId % AREAS) + 1;
    }

    return { areaId: nextAreaId, cellNum: nextCellNum };
  };
  
  if ((type === "main" || type === "home") && current_position === "0") {
    return {
      error: true,
      message: "Invalid state: main/home pawn cannot have position '0'.",
    };
  }

  // ===== base → start cell =====
  if (type === "base" && (!current_position || current_position === "0")) {
    if (dice_value === 6) {
      finalPosition = startPosition;
      finalType = "main";
      is_safe = 1;
      finalCellNum = 14;
      return { 
        finalPosition, 
        finalType, 
        is_safe, 
        moves, 
        startPosition, 
        finalCellNum
      };
    } else {
      return {
        error: true,
        message: "Cannot move a base pawn without rolling a 6."
      };
    }
  }

  if (type === "main" || type === "home") {
    let pos = { areaId, cellNum };

    for (let s = 0; s < dice_value; s++) {
      pos = stepForward(pos);

      // reached center / finished
      if (pos.cellNum === null || pos.areaId === null) {
        if (s < dice_value - 1) {
          return { error: true, message: "Move overshoots center." };
        }
        
        finalPosition = toCell(pos); // "finished"
        finalType = "center";
        is_safe = 1;
        moves = dice_value;
        finalCellNum = null;
        return { 
          finalPosition,
          finalType, 
          is_safe,
          moves,
          startPosition, 
          finalCellNum
        };
      }
    }

    finalPosition = toCell(pos);
    moves = dice_value;
    finalCellNum = pos.cellNum;

    if (pos.cellNum >= 8 && pos.cellNum <= 12) {
      finalType = "home";
      is_safe = 1;
    } else {
      finalType = "main";
      is_safe = SAFE_IDS.has(pos.cellNum) ? 1 : 0;
    }
    
    return { 
      finalPosition, 
      finalType, 
      is_safe, 
      moves, 
      startPosition, 
      finalCellNum
    };
  }
}
