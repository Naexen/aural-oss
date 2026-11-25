import { z } from "zod";

const line = z.string().trim().min(1).max(600);
const identifier = z.string().trim().min(1).max(100);

const plannedQuestion = z.object({
  prompt: line,
  criterion: line,
  strongAnswer: line,
  minutes: z.number().int().min(1).max(90),
});

const question = plannedQuestion.extend({ id: identifier });

export const briefOutput = z.object({
  summary: line,
  verify: z.array(line).min(1).max(5),
  agenda: z.array(plannedQuestion).min(2).max(6),
});

export const evaluationOutput = z.object({
  score: z.number().int().min(1).max(5).nullable(),
  feedback: line,
  evidence: z.array(z.object({ segmentId: identifier, quote: line })).max(4),
  followUp: line.nullable(),
  nextQuestionId: identifier.nullable(),
});

const segment = z.object({
  id: identifier,
  text: z.string().max(1800),
  role: z.enum(["candidate", "interviewer", "unknown"]),
  finalized: z.boolean(),
});

export const interviewRequest = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("prepare"),
    jobDescription: z.string().trim().min(1).max(16000),
    resume: z.string().trim().min(1).max(24000),
    durationMinutes: z.number().int().min(10).max(90),
  }),
  z.object({
    action: z.literal("evaluate"),
    question,
    remainingQuestions: z.array(question).max(5),
    segments: z.array(segment).max(40),
  }),
]);

export type InterviewRequest = z.infer<typeof interviewRequest>;
export type InterviewQuestion = z.infer<typeof question>;
export type InterviewBrief = Omit<z.infer<typeof briefOutput>, "agenda"> & { agenda: InterviewQuestion[] };
export type AnswerEvaluation = z.infer<typeof evaluationOutput>;
