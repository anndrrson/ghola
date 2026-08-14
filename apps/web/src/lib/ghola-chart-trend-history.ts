export interface GholaScopedTrendDrawing {
  id: string;
  scope: string;
}

export interface GholaTrendHistory<T extends GholaScopedTrendDrawing> {
  drawings: T[];
  redo: T[];
}

export function undoGholaTrendDrawing<T extends GholaScopedTrendDrawing>(
  history: GholaTrendHistory<T>,
  scope: string,
  limit: number,
): GholaTrendHistory<T> {
  const index = history.drawings.findLastIndex((drawing) => drawing.scope === scope);
  if (index < 0) return history;
  const target = history.drawings[index];
  return {
    drawings: history.drawings.filter((_, drawingIndex) => drawingIndex !== index),
    redo: boundScope(history.redo.concat(target), scope, limit),
  };
}

export function redoGholaTrendDrawing<T extends GholaScopedTrendDrawing>(
  history: GholaTrendHistory<T>,
  scope: string,
  limit: number,
): GholaTrendHistory<T> {
  const index = history.redo.findLastIndex((drawing) => drawing.scope === scope);
  if (index < 0) return history;
  const target = history.redo[index];
  const redo = history.redo.filter((_, drawingIndex) => drawingIndex !== index);
  if (history.drawings.some((drawing) => drawing.id === target.id)) return { drawings: history.drawings, redo };
  return {
    drawings: boundScope(history.drawings.concat(target), scope, limit),
    redo,
  };
}

export function removeGholaTrendDrawing<T extends GholaScopedTrendDrawing>(
  history: GholaTrendHistory<T>,
  scope: string,
  drawingId: string,
  limit: number,
): GholaTrendHistory<T> {
  const index = history.drawings.findIndex(
    (drawing) => drawing.scope === scope && drawing.id === drawingId,
  );
  if (index < 0) return history;
  const target = history.drawings[index];
  return {
    drawings: history.drawings.filter((_, drawingIndex) => drawingIndex !== index),
    redo: boundScope(history.redo.concat(target), scope, limit),
  };
}

export function clearGholaTrendDrawingRedo<T extends GholaScopedTrendDrawing>(
  drawings: T[],
): GholaTrendHistory<T> {
  return { drawings, redo: [] };
}

function boundedLimit(value: number) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 100) : 1;
}

function boundScope<T extends GholaScopedTrendDrawing>(items: T[], scope: string, limit: number) {
  let excess = items.filter((item) => item.scope === scope).length - boundedLimit(limit);
  if (excess <= 0) return items;
  return items.filter((item) => {
    if (item.scope !== scope || excess <= 0) return true;
    excess -= 1;
    return false;
  });
}
