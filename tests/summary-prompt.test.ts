import assert from "node:assert/strict";
import test from "node:test";

import { buildSummaryPrompt } from "../src/lib/ai/prompts/summary";

test("summary prompt preserves speaker attribution for stored and live messages", () => {
  for (const [interviewerRole, participantRole] of [
    ["ASSISTANT", "USER"],
    ["assistant", "user"],
  ]) {
    const [prompt] = buildSummaryPrompt("Technical interview", [
      { role: interviewerRole, content: "你如何验证结果？" },
      { role: participantRole, content: "我用三次独立测试复现了结果。" },
    ]);

    assert.ok(typeof prompt.content === "string");
    assert.ok(
      prompt.content.includes(
        "Interviewer: 你如何验证结果？\n\nParticipant: 我用三次独立测试复现了结果。",
      ),
    );
  }
});
