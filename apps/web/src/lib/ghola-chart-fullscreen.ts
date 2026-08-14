export type GholaChartFullscreenResult =
  | "enter_requested"
  | "exit_requested"
  | "occupied"
  | "unsupported"
  | "failed";

export interface GholaChartFullscreenDocument {
  fullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

export interface GholaChartFullscreenTarget {
  requestFullscreen?: () => Promise<void> | void;
  webkitRequestFullscreen?: () => Promise<void> | void;
}

export function gholaChartFullscreenElement(documentLike: GholaChartFullscreenDocument) {
  return documentLike.fullscreenElement ?? documentLike.webkitFullscreenElement ?? null;
}

export function gholaChartFullscreenSupported(
  documentLike: GholaChartFullscreenDocument,
  target: GholaChartFullscreenTarget | null,
) {
  return Boolean(
    target
    && ((target.requestFullscreen && documentLike.exitFullscreen)
      || (target.webkitRequestFullscreen && documentLike.webkitExitFullscreen)),
  );
}

export async function toggleGholaChartFullscreen(
  documentLike: GholaChartFullscreenDocument,
  target: GholaChartFullscreenTarget | null,
): Promise<GholaChartFullscreenResult> {
  if (!target || !gholaChartFullscreenSupported(documentLike, target)) return "unsupported";
  const current = gholaChartFullscreenElement(documentLike);
  try {
    if (current === target) {
      const exit = documentLike.exitFullscreen ?? documentLike.webkitExitFullscreen;
      await Promise.resolve(exit?.call(documentLike));
      return "exit_requested";
    }
    if (current) return "occupied";
    const enter = target.requestFullscreen ?? target.webkitRequestFullscreen;
    await Promise.resolve(enter?.call(target));
    return "enter_requested";
  } catch {
    return "failed";
  }
}
