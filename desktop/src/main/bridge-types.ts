import type { AnswerEvaluation, InterviewBrief, InterviewRequest } from "../../../src/lib/human-interview/contracts";

export type TextTask = "prepare" | "suggest" | "score" | "polish";
export type TextProtocol = "compatible" | "anthropic" | "gemini";
export const speechProviders = ["qwen-audio", "seed", "whisper-http", "qwen"] as const;
export type SpeechProvider = typeof speechProviders[number];

export interface PublicTextProfile {
  protocol: TextProtocol;
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

export interface PublicSpeechProfile {
  provider: SpeechProvider;
  baseUrl: string;
  model: string;
  enabled: boolean;
  hasKey: boolean;
  configured: boolean;
}

export interface PublicSettings {
  text: PublicTextProfile;
  tasks: Partial<Record<TextTask, PublicTextProfile>>;
  speech: PublicSpeechProfile;
}

type SecretUpdate = { apiKey?: string; clearKey?: boolean };
export type TextConnectionDraft = {
  protocol: "compatible" | "anthropic";
  baseUrl: string;
} & SecretUpdate;

export type SettingsTextUpdate = Omit<PublicTextProfile, "hasKey"> & SecretUpdate;
export type SettingsSpeechUpdate = Omit<PublicSpeechProfile, "hasKey" | "enabled" | "configured"> & { enabled?: boolean } & SecretUpdate;

export interface SettingsUpdate {
  text?: SettingsTextUpdate;
  tasks?: Partial<Record<TextTask, SettingsTextUpdate | null>>;
  speech?: SettingsSpeechUpdate;
}

export interface TextInputs {
  prepare: { jobDescription?: string; resume?: string; durationMinutes: number };
  suggest: Omit<Extract<InterviewRequest, { action: "evaluate" }>, "action">;
  score: Omit<Extract<InterviewRequest, { action: "evaluate" }>, "action">;
  polish: { draft: string };
}

export interface TextResults {
  prepare: InterviewBrief;
  suggest: Pick<AnswerEvaluation, "followUp" | "nextQuestionId">;
  score: AnswerEvaluation;
  polish: { text: string };
}

export type OverlayAction = "mic" | "suggest" | "score" | "next" | "show-main";

export interface OverlayState {
  status: string;
  phase: "idle" | "live" | "ended";
  startedAt?: number;
  endedAt?: number;
  transcript?: { label: string; text: string; partial?: boolean }[];
  question?: string | null;
  followUp?: string | null;
  nextQuestion?: string | null;
  feedback?: string | null;
  score?: number | null;
  listening?: boolean;
  busy?: boolean;
  canScore?: boolean;
  canSuggest?: boolean;
}

export type AsrEvent =
  | { type: "interim" | "final"; id: string; text: string }
  | { type: "status"; status: "connecting" | "ready" | "stopped" }
  | { type: "error"; message: string };

export interface DesktopBridge {
  getSettings(): Promise<PublicSettings>;
  saveSettings(update: SettingsUpdate): Promise<PublicSettings>;
  runText<T extends TextTask>(task: T, input: TextInputs[T]): Promise<TextResults[T]>;
  testText(task?: TextTask): Promise<{ ok: true }>;
  listTextModels(connection: TextConnectionDraft, task?: TextTask): Promise<string[]>;
  copyDraft(text: string): Promise<void>;
  testAsr(): Promise<void>;
  startAsr(options: { language?: string }): Promise<void>;
  sendAsrAudio(pcm: ArrayBuffer): void;
  stopAsr(): Promise<void>;
  onAsrEvent(listener: (event: AsrEvent) => void): () => void;
  setOverlayOpen(open: boolean): Promise<void>;
  setOverlayCompact(compact: boolean): Promise<void>;
  setOverlayState(state: OverlayState): void;
  getOverlayState(): Promise<OverlayState | null>;
  onOverlayState(listener: (state: OverlayState) => void): () => void;
  overlayAction(action: OverlayAction): void;
  onOverlayAction(listener: (action: OverlayAction) => void): () => void;
  closeOverlay(): Promise<void>;
}

declare global {
  interface Window {
    auralDesktop: DesktopBridge;
  }
}
