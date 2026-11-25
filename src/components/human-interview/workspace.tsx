"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AnswerEvaluation, InterviewBrief, InterviewRequest } from "@/lib/human-interview/contracts";
import { exampleBrief, exampleIntake, exampleTurns } from "@/lib/human-interview/example";
import { getCandidateEvidence, validateEvidence, type SpeakerRole, type TranscriptSegment } from "@/lib/human-interview/transcript";
import { cn } from "@/lib/utils";

const roles: Record<SpeakerRole, { label: string; className: string }> = {
  interviewer: { label: "面试官", className: "bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200" },
  candidate: { label: "候选人", className: "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200" },
  unknown: { label: "待确认", className: "bg-muted text-muted-foreground" },
};

async function requestAnalysis<T>(request: InterviewRequest): Promise<T> {
  const response = await fetch("/api/human-interview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.data) {
    throw new Error(typeof body?.error === "string" ? body.error : "分析请求未完成，请重试。");
  }
  return body.data as T;
}

export function HumanInterviewWorkspace({ modelReady }: { modelReady: boolean }) {
  const [tab, setTab] = useState<"prep" | "review">("prep");
  const [jobDescription, setJobDescription] = useState("");
  const [resume, setResume] = useState("");
  const [duration, setDuration] = useState("30");
  const [brief, setBrief] = useState<InterviewBrief | null>(null);
  const [replay, setReplay] = useState(false);
  const [questionId, setQuestionId] = useState("");
  const [transcripts, setTranscripts] = useState<Record<string, TranscriptSegment[]>>({});
  const [replayPositions, setReplayPositions] = useState<Record<string, number>>({});
  const [evaluations, setEvaluations] = useState<Record<string, AnswerEvaluation | undefined>>({});
  const [entry, setEntry] = useState("");
  const [role, setRole] = useState<SpeakerRole>("candidate");
  const [busy, setBusy] = useState<"prep" | "review" | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const agenda = brief?.agenda ?? [];
  const question = agenda.find((item) => item.id === questionId);
  const segments = transcripts[questionId] ?? [];
  const evaluation = evaluations[questionId];
  const next = agenda.find((item) => item.id === evaluation?.nextQuestionId && !evaluations[item.id]);
  const example = replay ? exampleTurns[questionId] : undefined;
  const replayPosition = replayPositions[questionId] ?? 0;
  const reviewed = agenda.filter((item) => evaluations[item.id]);
  const canEvaluate = getCandidateEvidence(segments).length > 0;

  function openBrief(result: InterviewBrief, useReplay: boolean) {
    setBrief(result);
    setReplay(useReplay);
    setQuestionId(result.agenda[0].id);
    setTranscripts({});
    setReplayPositions({});
    setEvaluations({});
    setEntry("");
    setError("");
    setStatus("");
  }

  function loadExample() {
    setJobDescription(exampleIntake.jobDescription);
    setResume(exampleIntake.resume);
    setDuration(String(exampleIntake.durationMinutes));
    openBrief(exampleBrief, true);
  }

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("prep");
    setError("");
    setStatus("");
    try {
      const result = await requestAnalysis<InterviewBrief>({ action: "prepare", jobDescription, resume, durationMinutes: Number(duration) });
      openBrief(result, false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "简报生成失败。");
    } finally {
      setBusy(null);
    }
  }

  function selectQuestion(id: string) {
    setQuestionId(id);
    setEntry("");
    setError("");
    setStatus("");
  }

  function appendSegment(segment: TranscriptSegment) {
    setTranscripts((previous) => ({ ...previous, [questionId]: [...(previous[questionId] ?? []), segment] }));
    if (segment.role === "candidate") setEvaluations((previous) => ({ ...previous, [questionId]: undefined }));
    setError("");
    setStatus("");
  }

  function appendEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = entry.trim();
    if (text && segments.length < 40) {
      appendSegment({ id: crypto.randomUUID(), role, text, finalized: true });
      setEntry("");
    }
  }

  function stepReplay() {
    const segment = example?.segments[replayPosition];
    if (!segment || segments.length >= 40) return;
    appendSegment(segment);
    setReplayPositions((previous) => ({ ...previous, [questionId]: replayPosition + 1 }));
  }

  async function reviewAnswer() {
    if (!question || !canEvaluate) return;
    const request: Extract<InterviewRequest, { action: "evaluate" }> = {
      action: "evaluate",
      question,
      remainingQuestions: agenda.filter((item) => item.id !== question.id && !evaluations[item.id]),
      segments,
    };
    setError("");
    setStatus("");
    setBusy("review");
    try {
      let result: AnswerEvaluation;
      if (replay && example) {
        const sample = getCandidateEvidence(example.segments);
        const recorded = getCandidateEvidence(segments);
        if (recorded.length !== sample.length || !sample.every((item, index) => recorded[index]?.id === item.id && recorded[index]?.text === item.text)) {
          throw new Error("请先完整回放本题示例。自定义候选人回答可用 Qwen 模式点评。");
        }
        const nextQuestionId = request.remainingQuestions[0]?.id ?? null;
        if (!validateEvidence(recorded, example.evaluation.evidence)) throw new Error("示例证据未通过校验。");
        result = { ...example.evaluation, nextQuestionId };
      } else {
        result = await requestAnalysis<AnswerEvaluation>(request);
      }
      setEvaluations((previous) => ({ ...previous, [question.id]: result }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "暂时无法评价本题。");
    } finally {
      setBusy(null);
    }
  }

  async function copyDraft() {
    const sections = reviewed.map((item) => {
      const result = evaluations[item.id]!;
      return [
        `${item.criterion}｜${result.score === null ? "待核实" : `${result.score}/5（暂评）`}`,
        item.prompt,
        result.feedback,
        ...result.evidence.map((item) => `原话：「${item.quote}」`),
      ].join("\n");
    });
    setError("");
    try {
      await navigator.clipboard.writeText(`${replay ? "模拟回放 · " : ""}面评草稿\n\n${sections.join("\n\n")}`);
      setStatus("面评草稿已复制。");
    } catch {
      setError("无法访问剪贴板，可手动复制右侧面评内容。");
    }
  }

  return (
    <div lang="zh-CN" className="mx-auto w-full max-w-[1440px] space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">面试助手</h1>
        <span className="rounded-full bg-teal-100 px-2.5 py-1 text-xs font-medium text-teal-900 dark:bg-teal-950 dark:text-teal-200">
          {replay ? "模拟回放" : modelReady ? "Qwen · 文本录入" : "Qwen 未配置"}
        </span>
      </header>
      <nav className="flex gap-5 border-b text-sm" aria-label="面试阶段">
        <button type="button" disabled={!!busy} aria-current={tab === "prep" ? "step" : undefined} onClick={() => { setTab("prep"); setError(""); }}
          className={cn("border-b-2 px-1 pb-2", tab === "prep" ? "border-teal-700 font-semibold" : "border-transparent text-muted-foreground")}>
          面前准备
        </button>
        <button type="button" disabled={!brief || !!busy} aria-current={tab === "review" ? "step" : undefined} onClick={() => { setTab("review"); setError(""); }}
          className={cn("border-b-2 px-1 pb-2 disabled:opacity-50", tab === "review" ? "border-teal-700 font-semibold" : "border-transparent text-muted-foreground")}>
          面中辅助
        </button>
      </nav>
      {error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
      {status && <p role="status" className="text-sm text-muted-foreground">{status}</p>}

      {tab === "prep" && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <form onSubmit={prepare} className="space-y-4 rounded-lg border bg-card p-4 sm:p-5">
            <h2 className="text-base font-semibold">本场资料</h2>
            <label className="block space-y-2 text-sm"><span className="font-medium">岗位 JD</span>
              <Textarea value={jobDescription} onChange={(event) => setJobDescription(event.target.value)} rows={5} maxLength={16000} required disabled={!!busy} />
            </label>
            <label className="block space-y-2 text-sm"><span className="font-medium">简历文本</span>
              <Textarea value={resume} onChange={(event) => setResume(event.target.value)} rows={5} maxLength={24000} required disabled={!!busy} />
            </label>
            <label className="flex items-center gap-3 text-sm font-medium">计划时长（分钟）
              <input type="number" min={10} max={90} required value={duration} onChange={(event) => setDuration(event.target.value)} disabled={!!busy}
                className="w-20 rounded-md border bg-background px-3 py-1.5" />
            </label>
            <p className="text-xs text-muted-foreground">资料仅保留在当前页面。点击生成简报时，文本将发送给配置的 Qwen 服务。</p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={!modelReady || !!busy || !jobDescription.trim() || !resume.trim()}>{busy === "prep" ? "简报生成中…" : "生成简报"}</Button>
              <Button type="button" variant="outline" onClick={loadExample} disabled={!!busy}>加载示例</Button>
            </div>
          </form>
          <section className="space-y-4 rounded-lg border bg-card p-4 sm:p-5">
            <h2 className="text-base font-semibold">面前简报</h2>
            {brief ? (
              <>
                <p className="text-sm leading-relaxed">{brief.summary}</p>
                <div>
                  <h3 className="text-sm font-semibold">待核实</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{brief.verify.map((item, index) => <li key={index}>{item}</li>)}</ul>
                </div>
                <ol className="divide-y border-y text-sm">
                  {agenda.map((item) => (
                    <li key={item.id} className="flex items-start gap-3 py-2">
                      <span className="min-w-0 flex-1">{item.prompt}<span className="block text-xs text-muted-foreground">{item.criterion}</span></span>
                      <span className="shrink-0 text-muted-foreground">{item.minutes} 分钟</span>
                    </li>
                  ))}
                </ol>
                <Button type="button" onClick={() => { setTab("review"); setError(""); }} disabled={!!busy}>进入面中辅助</Button>
              </>
            ) : (<p className="text-sm text-muted-foreground">生成简报或加载示例后可查看提纲和待核实事项。</p>)}
          </section>
        </div>
      )}

      {tab === "review" && question && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2" role="group" aria-label="面试提纲">
              {agenda.map((item, index) => (
                <Button key={item.id} type="button" size="sm" variant={item.id === questionId ? "default" : "outline"}
                  aria-pressed={item.id === questionId} onClick={() => selectQuestion(item.id)} disabled={!!busy}>
                  {index + 1}. {item.criterion}
                </Button>
              ))}
            </div>
            <Button type="button" size="sm" variant="outline" onClick={copyDraft} disabled={!reviewed.length || !!busy}>复制面评草稿</Button>
          </div>
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <section className="rounded-lg border bg-card">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
                <h2 className="text-base font-semibold">对话转写</h2>
                {example && <Button type="button" size="sm" variant="outline" disabled={!!busy || replayPosition >= example.segments.length || segments.length >= 40} onClick={stepReplay}>回放下一段</Button>}
              </div>
              <ol className="min-h-48 max-h-[55vh] divide-y overflow-y-auto px-4" aria-live="polite">
                {segments.map((item) => (
                  <li key={item.id} id={`segment-${item.id}`} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 py-3 target:bg-accent">
                    <span className={cn("rounded px-2 py-0.5 text-xs font-medium", roles[item.role].className)}>{roles[item.role].label}</span>
                    <p className="break-words text-sm leading-relaxed">{item.text}</p>
                  </li>
                ))}
              </ol>
              {!segments.length && <p className="px-4 pb-4 text-sm text-muted-foreground">{replay ? "点击「回放下一段」载入示例发言。" : "选择说话人，再添加当前题的转写。"}</p>}
              <form onSubmit={appendEntry} className="space-y-2 border-t p-4">
                <label className="block space-y-2 text-sm"><span className="font-medium">追加转写文本</span>
                  <Textarea rows={2} maxLength={1800} value={entry} onChange={(event) => setEntry(event.target.value)} disabled={!!busy} />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <select aria-label="说话人" value={role} onChange={(event) => setRole(event.target.value as SpeakerRole)} disabled={!!busy} className="h-9 rounded-md border bg-background px-2 text-sm">
                    {Object.entries(roles).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
                  </select>
                  <Button type="submit" size="sm" variant="outline" disabled={!entry.trim() || !!busy || segments.length >= 40}>追加转写</Button>
                  <Button type="button" size="sm" className="ml-auto" onClick={reviewAnswer} disabled={!canEvaluate || !!busy}>{busy === "review" ? "点评中…" : "评本题"}</Button>
                </div>
                {segments.length >= 40 && <p className="text-xs text-muted-foreground">本题已达到 40 段转写，可继续评估或切换下一题。</p>}
              </form>
            </section>

            <section className="divide-y rounded-lg border bg-card px-4 sm:px-5">
              <div className="space-y-2 py-4">
                <div className="flex justify-between gap-3"><h2 className="text-base font-semibold">当前题目</h2><span className="text-sm tabular-nums text-muted-foreground">已评 {reviewed.length} / {agenda.length}</span></div>
                <p className="rounded-md bg-muted/55 p-3 font-medium">{question.prompt}</p>
                <p className="text-xs text-muted-foreground">{question.criterion} · 建议 {question.minutes} 分钟</p>
              </div>
              <div className="space-y-2 py-4" aria-live="polite">
                <h3 className="text-sm font-semibold">暂定评分</h3>
                {evaluation ? (
                  <div className="flex items-start gap-3">
                    <strong className="shrink-0 text-xl tabular-nums text-teal-700 dark:text-teal-300">{evaluation.score === null ? "待核实" : `${evaluation.score}/5`}</strong>
                    <p className="text-sm leading-relaxed">{evaluation.feedback}</p>
                  </div>
                ) : (<p className="text-sm text-muted-foreground">添加候选人转写后，点击「评本题」。</p>)}
              </div>
              {evaluation && (
                <>
                  <div className="space-y-2 py-4"><h3 className="text-sm font-semibold">证据原话</h3>
                    {evaluation.evidence.length ? evaluation.evidence.map((item, index) => (
                      <a key={`${item.segmentId}-${index}`} href={`#segment-${item.segmentId}`} className="block rounded-md bg-muted/55 p-2.5 text-sm hover:underline">「{item.quote}」</a>
                    )) : <p className="text-sm text-muted-foreground">证据不足。</p>}
                  </div>
                  <div className="space-y-2 py-4"><h3 className="text-sm font-semibold">建议追问</h3><p className="text-sm">{evaluation.followUp ?? "暂无"}</p></div>
                  <div className="space-y-2 py-4"><h3 className="text-sm font-semibold">下一主问题</h3>
                    {next ? <button type="button" onClick={() => selectQuestion(next.id)} disabled={!!busy} className="w-full rounded-md bg-muted/55 p-2.5 text-left text-sm hover:underline">{next.prompt}</button>
                      : <p className="text-sm text-muted-foreground">暂无建议，可按提纲选择。</p>}
                  </div>
                </>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
