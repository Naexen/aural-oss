import { MIC_AUDIO_SAMPLE_RATE } from "../../../src/lib/voice/mic-audio";

export type MicFrame = { pcm: ArrayBuffer; level: number };
type Microphone = { close(): void; drain(): Promise<ArrayBuffer | undefined> };

export async function openMicrophone(
  receive: (frame: MicFrame) => void,
  onEnded: () => void,
): Promise<Microphone> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  let silence: GainNode | undefined;
  let finishDrain: ((tail?: ArrayBuffer) => void) | undefined;
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    finishDrain?.();
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.port.close();
      worklet.disconnect();
    }
    source?.disconnect();
    silence?.disconnect();
    for (const track of stream.getTracks()) {
      track.removeEventListener("ended", onEnded);
      track.stop();
    }
    if (context && context.state !== "closed") void context.close().catch(() => {});
  }

  try {
    context = new AudioContext({ sampleRate: MIC_AUDIO_SAMPLE_RATE });
    await context.audioWorklet.addModule("./mic-worklet.js");
    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, "interview-mic");
    silence = context.createGain();
    silence.gain.value = 0;
    worklet.port.onmessage = (event: MessageEvent<MicFrame | { tail: ArrayBuffer }>) => {
      if ("tail" in event.data) finishDrain?.(event.data.tail);
      else receive(event.data);
    };
    worklet.onprocessorerror = onEnded;
    source.connect(worklet).connect(silence).connect(context.destination);
    await context.resume();
    for (const track of stream.getAudioTracks()) track.addEventListener("ended", onEnded, { once: true });
    return {
      close,
      drain() {
        return new Promise((resolve) => {
          const deadline = setTimeout(() => finishDrain?.(), 180);
          finishDrain = (tail) => {
            clearTimeout(deadline);
            finishDrain = undefined;
            resolve(tail);
          };
          worklet?.port.postMessage("drain");
        });
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
