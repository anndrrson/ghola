"use client";

type ProgressEventLike = {
  status?: string;
  file?: string;
  progress?: number;
};

type TranscriberOutput = {
  text?: string;
};

type Transcriber = (audio: string | Blob) => Promise<TranscriberOutput>;

let transcriberPromise: Promise<Transcriber> | null = null;
let transcriberReady = false;

const PRIVATE_VOICE_MODEL = "onnx-community/whisper-tiny.en";

function progressLabel(event: ProgressEventLike): string | null {
  if (typeof event.progress === "number" && event.file) {
    return `Loading private voice model ${Math.round(event.progress)}%`;
  }
  if (event.status === "ready") return "Private voice model ready.";
  if (event.status === "initiate") return "Preparing private voice model.";
  return null;
}

async function buildTranscriber(
  onStatus?: (status: string) => void,
): Promise<Transcriber> {
  const transformers = await import("@huggingface/transformers");
  const pipeline = transformers.pipeline as unknown as (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<Transcriber>;

  const progress_callback = (event: ProgressEventLike) => {
    const label = progressLabel(event);
    if (label) onStatus?.(label);
  };

  try {
    onStatus?.("Starting private voice model on this device.");
    const transcriber = await pipeline("automatic-speech-recognition", PRIVATE_VOICE_MODEL, {
      device: "webgpu",
      dtype: "q4",
      progress_callback,
    });
    transcriberReady = true;
    onStatus?.("Private voice ready.");
    return transcriber;
  } catch {
    onStatus?.("WebGPU unavailable. Falling back to local WASM transcription.");
    const transcriber = await pipeline("automatic-speech-recognition", PRIVATE_VOICE_MODEL, {
      dtype: "q4",
      progress_callback,
    });
    transcriberReady = true;
    onStatus?.("Private voice ready.");
    return transcriber;
  }
}

export function isPrivateVoiceReady(): boolean {
  return transcriberReady;
}

export async function warmPrivateVoice(
  onStatus?: (status: string) => void,
): Promise<void> {
  transcriberPromise ??= buildTranscriber(onStatus);
  await transcriberPromise;
}

export async function transcribePrivateAudio(
  audio: Blob,
  onStatus?: (status: string) => void,
): Promise<string> {
  transcriberPromise ??= buildTranscriber(onStatus);
  const transcriber = await transcriberPromise;
  onStatus?.("Transcribing locally. Audio is not uploaded to Ghola.");
  const url = URL.createObjectURL(audio);
  try {
    const output = await transcriber(url);
    return (output.text ?? "").trim();
  } finally {
    URL.revokeObjectURL(url);
  }
}
