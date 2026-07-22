const AREAS = 4;
const MAX_ID_PER_AREA = 18;

const homeAreaIdByColor = {
  blue: 1,
  red: 2,
  green: 3,
  yellow: 4,
};

const stepBackward = ({ areaId, cellNum, color }) => {
  let nextId;
  const homeArea = homeAreaIdByColor[color];
  
  if (cellNum === 13 && areaId !== homeArea) {
    nextId = 7;
  } else {
    nextId = cellNum - 1;
  }

  let nextArea = areaId;
  if (nextId < 1) {
    nextId = MAX_ID_PER_AREA;
    nextArea = areaId - 1;
    if (nextArea < 1) {
      nextArea = AREAS;
    }
  }
  
  return { areaId: nextArea, cellNum: nextId };
};

export default function handleDangerZoneMove(current_position, pawnColor) {
  if (!current_position || current_position === "0" || current_position === "finished") {
    return { newPosition: current_position, moves_lost: 0 };
  }

  const parts = current_position.split("-");
  const initialAreaId = Number(parts[2]);
  const initialCellNum = Number(parts[4]);

  let moves_lost = 0;
  
  // -1 Danger Zone
  if (initialCellNum === 3) {
    moves_lost = 1;
  }
  // -6 Danger Zone
  else if (initialCellNum === 7) {
    moves_lost = 6;
  }
  // -3 Danger Zone
  else if (initialCellNum === 18) {
    moves_lost = 3;
  }

  if (moves_lost === 0) {
    return { newPosition: current_position, moves_lost: 0 };
  }

  let currentPosObj = { areaId: initialAreaId, cellNum: initialCellNum, color: pawnColor };
  
  for (let i = 0; i < moves_lost; i++) {
    currentPosObj = stepBackward(currentPosObj);
  }

  const newPosition = `cell-area-${currentPosObj.areaId}-id-${currentPosObj.cellNum}`;

  return {
    newPosition,
    moves_lost
  };
}
