import type { AnswerEvaluation, InterviewBrief, InterviewQuestion } from "../../../src/lib/human-interview/contracts";
import { getCandidateEvidence, type SpeakerRole, type TranscriptSegment } from "../../../src/lib/human-interview/transcript";
import type { AsrEvent, OverlayAction, OverlayState, PublicSettings, TextInputs, TextResults, TextTask } from "../main/bridge-types";
import { openMicrophone } from "./mic";
import { showSettings } from "./settings";
import { elapsed, escapeHtml as h, icon, message } from "./ui";

const app = document.querySelector<HTMLElement>("#app")!;
const bridge = window.auralDesktop;
const roles = { unknown: "待确认", interviewer: "面试官", candidate: "候选人" } as const;
type Turn = {
  question: InterviewQuestion;
  entries: TranscriptSegment[];
  evaluation?: AnswerEvaluation;
  suggestion?: TextResults["suggest"];
};
const quickQuestions: InterviewQuestion[] = [
  { id: "q1", prompt: "请介绍一段与这个岗位最相关的经历，以及你负责的部分。", criterion: "岗位相关经验", strongAnswer: "说明实际职责、关键决策、交付和可核验结果。", minutes: 8 },
  { id: "q2", prompt: "那段经历中，最难的问题是什么？你怎么验证解决方案有效？", criterion: "解决问题", strongAnswer: "交代约束、备选方案、实际采取的行动及验证证据。", minutes: 10 },
  { id: "q3", prompt: "如果现在重做，你会调整哪个决定？为什么？", criterion: "复盘与判断", strongAnswer: "基于具体经验说明改进方案及取舍。", minutes: 8 },
];

if (new URLSearchParams(location.search).get("view") === "overlay") {
  startOverlay();
} else {
  startWorkspace();
}

function startWorkspace() {
  let settings: PublicSettings | undefined;
  let phase: OverlayState["phase"] = "idle";
  let start = 0;
  let end = 0;
  let turns: Turn[] = [];
  let index = 0;
  let intakeOpen = false;
  let jobDescription = "";
  let resume = "";
  let brief: InterviewBrief | undefined;
  let startWithMic = false;
  let role: SpeakerRole = "unknown";
  let entry = "";
  let notice = "";
  let issue = false;
  let busy: TextTask | undefined;
  let polished = "";
  let ending = false;
  let mic: "off" | "opening" | "local" | "streaming" = "off";
  let micGeneration = 0;
  let microphone: Awaited<ReturnType<typeof openMicrophone>> | undefined;
  let stoppingMic: Promise<void> | undefined;
  const segmentTurns = new Map<string, Turn>();
  const current = () => turns[index];
  const micEngaged = () => mic === "local" || mic === "streaming";
  const micStatus = () => ({ off: "麦克风关闭", opening: "正在连接", local: "麦克风开启 · 本地监听", streaming: "实时转写中" })[mic];
  const hasEvidence = () => Boolean(current() && getCandidateEvidence(current().entries).length);
  const activeSuggestion = () => current()?.suggestion ?? current()?.evaluation;
  const next = () => turns.find((turn) => turn.question.id === activeSuggestion()?.nextQuestionId);
  const textReady = (task: TextTask) => {
    if (!settings) return false;
    const profile = settings.tasks[task] ?? settings.text;
    return !!profile.model && (profile.hasKey || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(profile.baseUrl));
  };

  function showNotice(text: string, error = false) {
    notice = text;
    issue = error;
    const target = app.querySelector<HTMLElement>("[data-notice]");
    if (target) {
      target.textContent = notice;
      target.classList.toggle("error", issue);
    }
  }

  function openSettings(speech = false) {
    if (!settings || document.querySelector(".settings-modal")) return;
    showSettings(bridge, settings, (updated) => {
      settings = updated;
      render();
    }, speech ? "speech" : "text");
  }

  function home() {
    return `<main class="home"><section class="start-card">
      <div class="hero-icon">${icon("mic", 42)}</div>
      <h1>开始面试</h1>
      <label class="mic-switch">
        <span>${icon("mic")}电脑麦克风</span>
        <input type="checkbox" role="switch" id="start-mic" ${startWithMic ? "checked" : ""} aria-label="开始时开启电脑麦克风">
      </label>
      <details class="intake" ${intakeOpen ? "open" : ""}>
        <summary>${icon("folder")}<span>面试资料</span><span class="muted optional">选填</span>${icon("chevron", 15)}</summary>
        <div class="intake-body">
          <label>JD<textarea id="jd" rows="4" maxlength="16000" placeholder="粘贴岗位描述">${h(jobDescription)}</textarea></label>
          <label>简历<textarea id="resume" rows="4" maxlength="24000" placeholder="粘贴简历文本">${h(resume)}</textarea></label>
          <div class="brief-actions"><button class="button" type="button" data-action="prepare" ${busy ? "disabled" : ""}>${busy === "prepare" ? "生成中…" : "生成简报"}</button></div>
          ${brief ? `<div class="brief"><strong>候选人简报</strong><p>${h(brief.summary)}</p><ul>${brief.verify.map((item) => `<li>${h(item)}</li>`).join("")}</ul></div>` : ""}
        </div>
      </details>
      <button class="button primary start-button" type="button" data-action="start">${icon("mic")}开始面试</button>
      <div class="ready"><span class="dot ${settings?.text.hasKey ? "green" : ""}"></span>${settings?.text.hasKey ? "默认文本模型已配置" : "可直接开始 · 模型选配"}</div>
      <p class="notice ${issue ? "error" : ""}" data-notice role="status">${h(notice)}</p>
    </section></main>`;
  }

  function transcriptRows(turn: Turn) {
    if (!turn.entries.length) return `<div class="empty-note">本题暂无转写</div>`;
    return turn.entries.map((segment) => `<article class="segment ${segment.finalized ? "" : "partial"}" data-transcript-id="${h(segment.id)}">
      <label class="segment-role ${segment.role}"><select aria-label="更改此段说话人" data-segment="${h(segment.id)}">
        ${roleOptions(segment.role)}</select></label>
      <p>${h(segment.text)}</p>
    </article>`).join("");
  }

  function evaluationPanel(turn: Turn) {
    const evaluation = turn.evaluation;
    const suggestion = activeSuggestion();
    const nextTurn = next();
    return `<div class="analysis-actions">
      <button class="button" type="button" data-action="suggest" ${busy ? "disabled" : ""}>${icon("chat")}${busy === "suggest" ? "提问生成中…" : "建议提问"}</button>
      <button class="button primary" type="button" data-action="score" ${!hasEvidence() || busy ? "disabled" : ""}>${icon("star")}${busy === "score" ? "点评中…" : "评本题"}</button>
    </div>
    <div class="results">
      ${evaluation ? `<section class="result"><div class="small-label">本题暂评</div>
        <div class="rating">${evaluation.score === null ? "证据不足" : `${evaluation.score}<span> / 5</span>`}</div>
        <p>${h(evaluation.feedback)}</p>
        ${evaluation.evidence.map(({ segmentId, quote }) => `<blockquote><button class="citation" type="button" data-evidence="${h(segmentId)}">${h(quote)}</button></blockquote>`).join("")}
      </section>` : ""}
      ${suggestion?.followUp ? `<section class="result"><div class="small-label">建议追问</div><p>${h(suggestion.followUp)}</p></section>` : ""}
      ${nextTurn ? `<section class="result"><div class="small-label">建议下一题</div><p>${h(nextTurn.question.prompt)}</p>
        <button class="button compact-button" data-action="next" type="button">切换到建议题${icon("chevron", 15)}</button></section>` : ""}
      ${!evaluation && !suggestion ? `<div class="empty-note">确认候选人转写后可评分</div>` : ""}
    </div>`;
  }

  function live() {
    const turn = current();
    return `<main class="workspace">
      <div class="session-bar"><div><div class="session-heading"><h1>面试中</h1><span class="timer" data-clock>${elapsed(start)}</span></div></div>
        <div class="session-tools">
          <button class="button ${micEngaged() ? "blue" : ""}" data-action="mic" type="button" ${ending ? "disabled" : ""}>${icon(micEngaged() ? "mic" : "micOff")} ${mic === "off" ? "开启麦克风" : "关闭麦克风"}</button>
          <button class="button" data-action="end" type="button" ${ending ? "disabled" : ""}>${icon("stop")}${ending ? "结束中…" : "结束面试"}</button>
        </div>
      </div>
      <div class="question-tabs" aria-label="考察提纲">
        ${turns.map(({ question }, number) => `<button class="tag-button" data-index="${number}" type="button" aria-pressed="${index === number}">${h(question.criterion)}</button>`).join("")}
        <button class="tag-button add-question" data-action="new-question" type="button">${icon("plus", 15)}自定义题</button>
      </div>
      <div class="live-grid">
        <section class="panel transcript-panel" aria-labelledby="transcript-title">
          <header class="panel-header">
            <div><h2 id="transcript-title">实时转写</h2><div class="caption"><span class="dot ${micEngaged() ? "green" : ""}"></span>${micStatus()}</div></div>
            <div class="capture-tools"><progress value="0" max="1" id="mic-meter" aria-label="麦克风音量"></progress>
            <label class="input-role">录入归属<select id="capture-role">${roleOptions(role)}</select></label></div>
          </header>
          <div class="transcript-list" id="transcript-list">${transcriptRows(turn)}</div>
          <form id="manual-entry" class="manual-entry"><input id="entry" aria-label="添加转写" placeholder="补录一段发言" value="${h(entry)}" maxlength="1800">
            <button class="button" type="submit" aria-label="添加转写">${icon("plus")}添加</button></form>
        </section>
        <section class="panel analysis-panel" aria-labelledby="analysis-title">
          <div class="panel-header"><h2 id="analysis-title">当前问题</h2><span class="muted">${index + 1} / ${turns.length}</span></div>
          <p class="question">${h(turn.question.prompt)}</p>
          <div id="evaluation-panel">${evaluationPanel(turn)}</div>
        </section>
      </div>
      <p class="notice ${issue ? "error" : ""}" data-notice role="status">${h(notice)}</p>
    </main>`;
  }

  function draftText() {
    return turns.filter((turn) => turn.evaluation).map((turn) => {
      const evaluation = turn.evaluation!;
      return [`【${turn.question.criterion}】`, `问题：${turn.question.prompt}`, `暂评分：${evaluation.score === null ? "证据不足" : `${evaluation.score}/5`}`, evaluation.feedback, ...evaluation.evidence.map(({ quote }) => `候选人原话：${quote}`)].join("\n");
    }).join("\n\n");
  }

  function summary() {
    const draft = draftText();
    return `<main class="wrap-up"><section class="panel summary-panel"><div class="panel-header"><h1>面试结束</h1><span class="timer">${elapsed(start, end)}</span></div>
      <label>面评草稿<textarea id="summary-text" rows="10" readonly placeholder="本场暂无已评分题目">${h(polished || draft)}</textarea></label>
      <div class="summary-actions">
        <button class="button" data-action="reset" type="button">新面试</button>
        <button class="button" data-action="polish" type="button" ${!draft || !!busy ? "disabled" : ""}>${busy ? "整理中…" : "整理草稿"}</button>
        <button class="button primary" data-action="copy" type="button" ${!draft ? "disabled" : ""}>${icon("copy")}复制到 Moka</button>
      </div><p class="notice ${issue ? "error" : ""}" data-notice role="status">${h(notice)}</p></section></main>`;
  }

  function publish() {
    const currentTurn = phase === "idle" ? undefined : current();
    bridge.setOverlayState({
      phase,
      status: phase === "live" ? micStatus() : phase === "ended" ? "面试结束" : "未开始",
      startedAt: start || undefined,
      endedAt: end || undefined,
      listening: micEngaged(),
      question: currentTurn?.question.prompt,
      transcript: currentTurn?.entries.slice(-12).map((item) => ({ label: roles[item.role], text: item.text, partial: !item.finalized })),
      score: currentTurn?.evaluation?.score,
      feedback: currentTurn?.evaluation?.feedback,
      followUp: activeSuggestion()?.followUp,
      nextQuestion: next()?.question.prompt,
      canScore: phase === "live" && hasEvidence(),
      canSuggest: phase === "live",
      busy: !!busy,
    });
  }

  function render() {
    app.innerHTML = `<header class="toolbar"><div class="brand"><span class="brand-icon">${icon("chat", 21)}</span>面试助手</div>
      <div class="toolbar-actions"><button class="button" data-action="settings" type="button">${icon("sliders")}模型设置</button>
      <button class="button" data-action="overlay" type="button">${icon("layers")}浮窗</button></div></header>
      ${phase === "idle" ? home() : phase === "live" ? live() : summary()}`;
    app.querySelector("details")?.addEventListener("toggle", (event) => {
      const details = event.currentTarget as HTMLDetailsElement;
      if (details.isConnected) intakeOpen = details.open;
    });
    publish();
  }

  function refreshTranscript() {
    const list = app.querySelector<HTMLElement>("#transcript-list");
    const assessment = app.querySelector<HTMLElement>("#evaluation-panel");
    if (phase !== "live" || !list || !assessment) return;
    const nearBottom = list.scrollHeight - (list.scrollTop + list.clientHeight) < 40;
    const focused = document.activeElement as HTMLSelectElement | null;
    const activeId = focused?.dataset.segment;
    list.innerHTML = transcriptRows(current());
    if (nearBottom) list.scrollTop = list.scrollHeight;
    if (activeId) list.querySelector<HTMLElement>(`[data-segment="${CSS.escape(activeId)}"]`)?.focus({ preventScroll: true });
    assessment.innerHTML = evaluationPanel(current());
    publish();
  }

  function invalidateReview(turn: Turn) {
    turn.evaluation = undefined;
    turn.suggestion = undefined;
    polished = "";
  }

  function applyAsr(event: AsrEvent) {
    if (event.type === "error") {
      if (phase === "live" && mic !== "off") {
        mic = "local";
        render();
        showNotice(event.message, true);
      }
      return;
    }
    if (event.type === "status") {
      if (event.status === "stopped" && mic === "streaming") {
        mic = "local";
        render();
      }
      return;
    }
    if (phase !== "live") return;
    const id = `audio-${event.id}`.slice(0, 100);
    const turn = segmentTurns.get(id) ?? current();
    if (!turn) return;
    segmentTurns.set(id, turn);
    const existing = turn.entries.find((item) => item.id === id);
    if (existing?.finalized) return;
    if (!event.text.trim()) {
      if (existing) turn.entries.splice(turn.entries.indexOf(existing), 1);
    } else {
      const segment: TranscriptSegment = { id, role: existing?.role ?? role, text: event.text.slice(0, 1800), finalized: event.type === "final" };
      if (existing) turn.entries[turn.entries.indexOf(existing)] = segment;
      else turn.entries.push(segment);
      if (segment.finalized && segment.role === "candidate") invalidateReview(turn);
    }
    if (turn === current()) refreshTranscript();
  }

  function stopMic() {
    if (stoppingMic) return stoppingMic;
    const activeMic = microphone;
    const streaming = mic === "streaming";
    micGeneration++;
    microphone = undefined;
    mic = "off";
    stoppingMic = (async () => {
      try {
        if (streaming && activeMic) {
          const tail = await activeMic.drain();
          if (tail?.byteLength) bridge.sendAsrAudio(tail);
        }
        activeMic?.close();
        await bridge.stopAsr();
      } catch (error) {
        showNotice(message(error, "关闭语音识别失败"), true);
      } finally {
        activeMic?.close();
        stoppingMic = undefined;
        render();
      }
    })();
    render();
    return stoppingMic;
  }

  async function toggleMic() {
    if (phase !== "live" || ending || stoppingMic) return;
    if (mic !== "off") {
      await stopMic();
      return;
    }
    const generation = ++micGeneration;
    mic = "opening";
    showNotice("");
    render();
    try {
      const opened = await openMicrophone(({ pcm, level }) => {
        if (micGeneration !== generation) return;
        const meter = app.querySelector<HTMLProgressElement>("#mic-meter");
        if (meter) meter.value = Math.min(1, level * 5);
        if (mic === "streaming") bridge.sendAsrAudio(pcm);
      }, () => {
        if (micGeneration !== generation) return;
        void stopMic();
        showNotice("麦克风已断开", true);
      });
      if (micGeneration !== generation || phase !== "live") {
        opened.close();
        return;
      }
      microphone = opened;
      if (settings?.speech.enabled && settings.speech.hasKey) {
        await bridge.startAsr({ language: "zh" });
        if (micGeneration !== generation) return;
        mic = "streaming";
      } else {
        mic = "local";
        showNotice("在「模型设置 → 语音识别」配置转写服务。");
      }
    } catch (error) {
      if (micGeneration !== generation) return;
      mic = microphone ? "local" : "off";
      showNotice(message(error, "无法访问电脑麦克风"), true);
    }
    render();
  }

  function startInterview() {
    if (phase !== "idle" || busy) return;
    turns = (brief?.agenda ?? quickQuestions).map((question) => ({ question, entries: [] }));
    index = 0;
    role = "unknown";
    entry = "";
    notice = "";
    end = 0;
    start = Date.now();
    phase = "live";
    render();
    if (startWithMic) void toggleMic();
  }

  async function prepare() {
    if (busy) return;
    if (!textReady("prepare")) { openSettings(); return; }
    const input = { jobDescription: jobDescription || undefined, resume: resume || undefined, durationMinutes: 30 };
    await runTask("prepare", input, (result) => {
      if (jobDescription.trim() === (input.jobDescription ?? "").trim() && resume.trim() === (input.resume ?? "").trim()) brief = result;
    });
  }

  async function review(task: "suggest" | "score") {
    if (phase !== "live" || busy || (task === "score" && !hasEvidence())) return;
    if (!textReady(task)) { openSettings(); return; }
    const turn = current();
    const fingerprint = JSON.stringify(getCandidateEvidence(turn.entries));
    const input = {
      question: turn.question,
      remainingQuestions: turns.slice(index + 1).map(({ question }) => question),
      segments: turn.entries.filter((item) => item.role === "candidate" && item.finalized).slice(-40),
    };
    if (task === "suggest") await runTask(task, input, (result) => {
      if (fingerprint === JSON.stringify(getCandidateEvidence(turn.entries))) turn.suggestion = result;
    });
    else await runTask(task, input, (result) => {
      if (fingerprint === JSON.stringify(getCandidateEvidence(turn.entries))) {
        turn.evaluation = result;
        turn.suggestion = undefined;
      } else showNotice("本题证据已有更新，请重新评分。");
    });
  }

  async function runTask<T extends TextTask>(task: T, input: TextInputs[T], apply: (result: TextResults[T]) => void) {
    if (busy) return;
    busy = task;
    showNotice("");
    render();
    try {
      apply(await bridge.runText(task, input));
    } catch (error) {
      showNotice(message(error, "模型请求失败"), true);
    } finally {
      busy = undefined;
      render();
    }
  }

  function addQuestion() {
    if (turns.length >= 6) { showNotice("一场最多 6 道主问题。"); return; }
    const dialog = document.createElement("dialog");
    dialog.className = "question-modal";
    dialog.innerHTML = `<form><h2>自定义题</h2>
      <label>问题<input name="prompt" required maxlength="600"></label>
      <label>考察维度<input name="criterion" required maxlength="120"></label>
      <label>评分依据<input name="criteria" required maxlength="600"></label>
      <div class="summary-actions"><button type="button" class="button" data-cancel>取消</button><button type="submit" class="button primary">添加</button></div></form>`;
    document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove());
    dialog.querySelector("[data-cancel]")?.addEventListener("click", () => dialog.close());
    dialog.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget as HTMLFormElement);
      const prompt = String(data.get("prompt") ?? "").trim();
      const criterion = String(data.get("criterion") ?? "").trim();
      const strongAnswer = String(data.get("criteria") ?? "").trim();
      if (!prompt || !criterion || !strongAnswer) return;
      turns.push({ question: { prompt, criterion, strongAnswer, id: crypto.randomUUID(), minutes: 5 }, entries: [] });
      index = turns.length - 1;
      dialog.close();
      render();
    });
    dialog.showModal();
  }

  function changeQuestion(newIndex: number) {
    if (!turns[newIndex]) return;
    index = newIndex;
    entry = "";
    showNotice("");
    render();
  }

  async function endInterview() {
    if (phase !== "live" || ending) return;
    ending = true;
    showNotice("");
    await stopMic();
    end = Date.now();
    phase = "ended";
    ending = false;
    render();
  }

  function runAction(action: string) {
    switch (action) {
      case "settings": openSettings(); break;
      case "overlay": void bridge.setOverlayOpen(true).catch((error) => showNotice(message(error), true)); break;
      case "start": startInterview(); break;
      case "prepare": void prepare(); break;
      case "mic": void toggleMic(); break;
      case "new-question": addQuestion(); break;
      case "score": void review("score"); break;
      case "suggest": void review("suggest"); break;
      case "next": if (next()) changeQuestion(turns.indexOf(next()!)); break;
      case "end": void endInterview(); break;
      case "reset":
        turns = [];
        segmentTurns.clear();
        phase = "idle";
        polished = "";
        jobDescription = "";
        resume = "";
        brief = undefined;
        intakeOpen = false;
        start = 0;
        end = 0;
        showNotice("");
        render();
        break;
      case "polish":
        if (!textReady("polish")) { openSettings(); break; }
        void runTask("polish", { draft: draftText() }, ({ text }) => { polished = text; });
        break;
      case "copy": void bridge.copyDraft(polished || draftText()).then(
        () => showNotice("已复制面评草稿"),
        () => showNotice("复制失败，可手动选中草稿复制", true),
      ); break;
    }
  }

  app.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button");
    if (!button) return;
    if (button.dataset.action) runAction(button.dataset.action);
    if (button.dataset.index) changeQuestion(Number(button.dataset.index));
    if (button.dataset.evidence) {
      const target = app.querySelector<HTMLElement>(`[data-transcript-id="${CSS.escape(button.dataset.evidence)}"]`);
      target?.scrollIntoView({ block: "nearest" });
      target?.querySelector("select")?.focus({ preventScroll: true });
    }
  });
  app.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.id === "jd") { jobDescription = input.value; brief = undefined; app.querySelector(".brief")?.remove(); }
    if (input.id === "resume") { resume = input.value; brief = undefined; app.querySelector(".brief")?.remove(); }
    if (input.id === "entry") entry = input.value;
  });
  app.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement | HTMLSelectElement;
    if (input.id === "start-mic" && input instanceof HTMLInputElement) startWithMic = input.checked;
    if (input.id === "capture-role") role = input.value as SpeakerRole;
    if (input.dataset.segment) {
      const turn = current();
      const item = turn.entries.find((segment) => segment.id === input.dataset.segment);
      if (item && item.role !== input.value) {
        const previous = item.role;
        item.role = input.value as SpeakerRole;
        if (item.finalized && (previous === "candidate" || item.role === "candidate")) invalidateReview(turn);
        refreshTranscript();
      }
    }
  });
  app.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement;
    if (form.id !== "manual-entry") return;
    event.preventDefault();
    if (!entry.trim()) return;
    current().entries.push({ id: crypto.randomUUID(), role, text: entry.trim(), finalized: true });
    if (role === "candidate") invalidateReview(current());
    entry = "";
    const input = form.querySelector("input");
    if (input) input.value = "";
    refreshTranscript();
  });

  bridge.onOverlayAction((action) => runAction(action));
  bridge.onAsrEvent(applyAsr);
  window.addEventListener("pagehide", () => microphone?.close(), { once: true });
  setInterval(() => {
    const clock = app.querySelector("[data-clock]");
    if (clock && start) clock.textContent = elapsed(start);
  }, 1000);
  render();
  void bridge.getSettings().then((value) => { settings = value; render(); }, (error) => showNotice(message(error), true));
}

function roleOptions(selected: SpeakerRole) {
  return (Object.keys(roles) as SpeakerRole[]).map((key) => `<option value="${key}" ${key === selected ? "selected" : ""}>${roles[key]}</option>`).join("");
}

function startOverlay() {
  document.body.classList.add("overlay-page");
  let state: OverlayState = { phase: "idle", status: "未开始" };
  let compact = false;
  let tab: "transcript" | "assessment" = "transcript";

  function render() {
    const live = state.phase === "live";
    const status = live ? (state.listening ? "麦克风开启" : "面试中") : state.status;
    const clock = state.startedAt ? elapsed(state.startedAt, state.endedAt) : "00:00:00";
    app.innerHTML = `<main class="overlay-shell ${compact ? "is-compact" : ""}">
      <header class="overlay-heading"><span class="dot ${state.listening ? "green" : ""}"></span><strong>${h(status)}</strong>
        <span class="timer" data-clock>${clock}</span><div class="window-actions">
          <button class="icon-button" data-action="compact" type="button" aria-label="${compact ? "展开浮窗" : "收起浮窗"}">${icon(compact ? "expand" : "minus", 17)}</button>
          <button class="icon-button" data-action="close" type="button" aria-label="关闭浮窗">${icon("close", 17)}</button>
        </div></header>
      ${compact ? "" : `<div class="overlay-pane">
        <div class="segment-tabs" aria-label="浮窗视图"><button data-tab="transcript" type="button" aria-pressed="${tab === "transcript"}">实时转写</button>
          <button data-tab="assessment" type="button" aria-pressed="${tab === "assessment"}">评估</button></div>
        <div class="overlay-feed">${tab === "transcript"
          ? (state.transcript?.length ? state.transcript.map((segment) => `<article class="overlay-segment ${segment.partial ? "partial" : ""}">
                <span class="role-chip ${segment.label === "候选人" ? "blue" : ""}">${h(segment.label)}</span><p>${h(segment.text)}</p></article>`).join("") : `<div class="empty-note">${live ? "暂无转写" : h(state.status)}</div>`)
          : `${state.question ? `<div class="overlay-result"><div class="small-label">当前问题</div><p>${h(state.question)}</p></div>` : ""}
             ${state.feedback ? `<div class="overlay-result"><div class="small-label">本题暂评</div><strong>${state.score == null ? "证据不足" : `${state.score} / 5`}</strong><p>${h(state.feedback)}</p></div>` : ""}
             ${state.followUp ? `<div class="overlay-result"><div class="small-label">建议追问</div><p>${h(state.followUp)}</p></div>` : ""}
             ${state.nextQuestion ? `<div class="overlay-result"><div class="small-label">建议下一题</div><p>${h(state.nextQuestion)}</p>
               <button class="button compact-button" data-action="next" type="button">切换${icon("chevron", 14)}</button></div>` : ""}
             ${!state.question ? '<div class="empty-note">暂无评估</div>' : ""}`}</div>
        <footer class="overlay-actions">
          <button class="icon-button ${state.listening ? "blue" : ""}" data-action="mic" type="button" aria-label="${state.listening ? "关闭麦克风" : "开启麦克风"}" ${live ? "" : "disabled"}>${icon(state.listening ? "mic" : "micOff")}</button>
          <button class="button" data-action="suggest" type="button" ${state.canSuggest && !state.busy ? "" : "disabled"}>追问</button>
          <button class="button" data-action="score" type="button" ${state.canScore && !state.busy ? "" : "disabled"}>评本题</button>
          <button class="icon-button" data-action="show-main" type="button" aria-label="显示主窗口">${icon("layers")}</button>
        </footer></div>`}
    </main>`;
    const feed = app.querySelector<HTMLElement>(".overlay-feed");
    if (tab === "transcript" && feed) feed.scrollTop = feed.scrollHeight;
  }

  app.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button");
    if (!button) return;
    if (button.dataset.tab === "transcript" || button.dataset.tab === "assessment") {
      tab = button.dataset.tab;
      render();
    }
    const action = button.dataset.action;
    if (action === "close") void bridge.closeOverlay();
    if (action === "compact") {
      compact = !compact;
      void bridge.setOverlayCompact(compact);
      render();
    }
    if (action && ["mic", "score", "suggest", "next", "show-main"].includes(action)) {
      if (action === "score" || action === "suggest") { tab = "assessment"; render(); }
      bridge.overlayAction(action as OverlayAction);
    }
  });
  let updates = 0;
  bridge.onOverlayState((value) => { updates++; state = value; render(); });
  void bridge.getOverlayState().then((value) => {
    if (value && updates === 0) { state = value; render(); }
  });
  setInterval(() => {
    const clock = app.querySelector("[data-clock]");
    if (clock && state.startedAt && state.phase === "live") clock.textContent = elapsed(state.startedAt);
  }, 1000);
  render();
}
