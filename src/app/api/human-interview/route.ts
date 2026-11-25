import { checkRateLimit } from "@/lib/api-rate-limit";
import { getAuthUser } from "@/lib/auth";
import { evaluateInterviewAnswer, prepareInterviewAnalysis } from "@/lib/human-interview/analysis";
import { interviewRequest } from "@/lib/human-interview/contracts";
import { getQwenSettings, QwenRequestError, requestQwenJson } from "@/lib/human-interview/qwen";

function json(body: object, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return json({ error: "请先登录 Aural。" }, 401);

  const rateLimit = checkRateLimit(`human-interview:${user.id}`);
  if (rateLimit) return rateLimit;

  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return json({ error: "请发送 JSON 格式的面试资料。" }, 415);
  }

  const input = interviewRequest.safeParse(await request.json().catch(() => null));
  if (!input.success) return json({ error: "面试资料不完整或超出长度限制。" }, 400);

  const analysis = input.data.action === "prepare" ? prepareInterviewAnalysis(input.data) : evaluateInterviewAnswer(input.data);
  if (!analysis) return json({ error: "本题还没有可引用的候选人正式转写。" }, 422);

  try {
    const settings = getQwenSettings();
    if (!settings) return json({ error: "Qwen 尚未配置。请使用模拟回放，或由管理员配置 Qwen。" }, 503);

    const output = analysis.parse(await requestQwenJson(analysis.messages, settings, { signal: request.signal }));
    if (!output) return json({ error: "模型返回的结构或证据未通过校验，请重试。" }, 502);
    return json({ data: output });
  } catch (error) {
    if (error instanceof QwenRequestError) {
      if (error.code === "timeout") return json({ error: "Qwen 响应超时，请重试。" }, 504);
      if (error.code === "invalid_config") return json({ error: "请管理员检查 Qwen 配置。" }, 503);
      if (error.code === "invalid_json") return json({ error: "Qwen 未返回有效的结构化结果，请重试。" }, 502);
    }
    return json({ error: "本次模型请求未完成，请重试。" }, 502);
  }
}
