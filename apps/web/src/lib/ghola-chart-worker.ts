import {
  GholaChartEngineState,
  handleGholaChartWorkerRequest,
  type GholaChartWorkerRequest,
  type GholaChartWorkerResponse,
} from "./ghola-chart-engine";

const engine = new GholaChartEngineState();

self.onmessage = (event: MessageEvent<GholaChartWorkerRequest>) => {
  const response: GholaChartWorkerResponse = handleGholaChartWorkerRequest(engine, event.data);
  self.postMessage(response);
};
