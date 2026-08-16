import { describe, expect, it } from "vitest";
import {
  clearGholaTrendDrawingRedo,
  removeGholaTrendDrawing,
  redoGholaTrendDrawing,
  undoGholaTrendDrawing,
} from "./ghola-chart-trend-history";

describe("ghola chart trend history", () => {
  const main = (id: string) => ({ id, scope: "main", value: id });
  const test = (id: string) => ({ id, scope: "test", value: id });

  it("undoes and redoes the latest drawing in the active scope", () => {
    const initial = { drawings: [main("a"), test("x"), main("b")], redo: [] };
    const undone = undoGholaTrendDrawing(initial, "main", 8);
    expect(undone.drawings.map((item) => item.id)).toEqual(["a", "x"]);
    expect(undone.redo.map((item) => item.id)).toEqual(["b"]);
    expect(redoGholaTrendDrawing(undone, "main", 8).drawings.map((item) => item.id))
      .toEqual(["a", "x", "b"]);
  });

  it("keeps scopes isolated and bounds redo history", () => {
    const initial = { drawings: [main("a"), test("x")], redo: [test("saved"), main("old")] };
    const undone = undoGholaTrendDrawing(initial, "test", 1);
    expect(undone.drawings.map((item) => item.id)).toEqual(["a"]);
    expect(undone.redo.map((item) => item.id)).toEqual(["old", "x"]);
    expect(redoGholaTrendDrawing(undone, "missing", 8)).toBe(undone);
  });

  it("bounds only the active scope when redo restores a capped drawing", () => {
    const result = redoGholaTrendDrawing({
      drawings: [test("x"), main("a")],
      redo: [main("b")],
    }, "main", 1);
    expect(result.drawings.map((item) => item.id)).toEqual(["x", "b"]);
  });

  it("clears redo when a new history branch starts", () => {
    expect(clearGholaTrendDrawingRedo([main("new")])).toEqual({ drawings: [main("new")], redo: [] });
  });

  it("drops duplicate redo records without duplicating a drawing", () => {
    const result = redoGholaTrendDrawing({ drawings: [main("a")], redo: [main("a")] }, "main", 8);
    expect(result).toEqual({ drawings: [main("a")], redo: [] });
  });

  it("removes one exact scoped drawing and makes it recoverable", () => {
    const initial = { drawings: [main("a"), test("a"), main("b")], redo: [] };
    const removed = removeGholaTrendDrawing(initial, "main", "a", 8);
    expect(removed.drawings).toEqual([test("a"), main("b")]);
    expect(removed.redo).toEqual([main("a")]);
    expect(removeGholaTrendDrawing(initial, "main", "missing", 8)).toBe(initial);
  });
});
