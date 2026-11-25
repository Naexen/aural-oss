import type { AnswerEvaluation, InterviewBrief, InterviewRequest } from "./contracts";
import type { TranscriptSegment } from "./transcript";

export const exampleIntake: Extract<InterviewRequest, { action: "prepare" }> = {
  action: "prepare",
  jobDescription:
    "后端开发工程师，负责业务 API 与数据库。需要设计 Redis 缓存一致性方案，排查生产延迟，制定安全的上线与回滚计划。",
  resume:
    "模拟简历。候选人维护过订单查询接口，做过 Redis 缓存和慢查询优化，也参与过灰度发布。简历未说明并发场景、故障定位过程或个人负责范围。",
  durationMinutes: 30,
};

export const exampleBrief: InterviewBrief = {
  summary: "候选人有订单接口、缓存和上线经历，优先核实设计取舍、故障定位与个人贡献。",
  verify: [
    "缓存更新失败及并发读写如何处理。",
    "慢查询定位是否有可复核的数据和因果证据。",
    "灰度发布的回滚条件与候选人的实际职责。",
  ],
  agenda: [
    {
      id: "q1",
      prompt: "如何更新订单缓存？",
      criterion: "缓存一致性",
      strongAnswer: "说明数据库与缓存的更新顺序，以及并发读写、删除失败和监控验证的处理。",
      minutes: 10,
    },
    {
      id: "q2",
      prompt: "如何排查接口延迟？",
      criterion: "生产故障定位",
      strongAnswer: "用监控和链路拆解定位瓶颈，描述一次亲自验证的改动及前后数据。",
      minutes: 10,
    },
    {
      id: "q3",
      prompt: "怎样灰度上线和回滚？",
      criterion: "发布与风险控制",
      strongAnswer: "说明灰度范围、观测指标、具体回滚阈值、操作责任和回滚后的验证。",
      minutes: 10,
    },
  ],
};

export const exampleTurns: Record<string, {
  segments: TranscriptSegment[];
  evaluation: AnswerEvaluation;
}> = {
  q1: {
    segments: [
      { id: "q1-question", role: "interviewer", text: "你在订单查询项目里是怎么更新缓存的？", finalized: true },
      { id: "q1-answer", role: "candidate", text: "我先更新数据库，再删掉对应的 Redis 缓存。缓存设置五分钟过期，上线后看了命中率。当时没有特意验证并发读写。", finalized: true },
    ],
    evaluation: {
      score: 3,
      feedback: "说明了写库后删缓存的基本策略和过期设置。并发写入、缓存删除失败和数据一致性还需要验证。",
      evidence: [{ segmentId: "q1-answer", quote: "我先更新数据库，再删掉对应的 Redis 缓存。" }],
      followUp: "如果写库成功但缓存删除失败，你会怎么补偿并验证？",
      nextQuestionId: "q2",
    },
  },
  q2: {
    segments: [
      { id: "q2-question", role: "interviewer", text: "请举例说明你是如何排查接口延迟的。", finalized: true },
      { id: "q2-answer", role: "candidate", text: "我先拆开链路耗时，发现大部分时间花在订单查询上。我对比了执行计划，补了一个复合索引。同一批回放请求的 P95 从 420 毫秒降到了 180 毫秒。", finalized: true },
    ],
    evaluation: {
      score: 4,
      feedback: "能用链路和执行计划定位瓶颈，并给出同一批回放请求的前后对照。可再核实索引对写入的影响。",
      evidence: [{ segmentId: "q2-answer", quote: "同一批回放请求的 P95 从 420 毫秒降到了 180 毫秒。" }],
      followUp: "新增索引后，你观察了哪些写入指标？",
      nextQuestionId: "q3",
    },
  },
  q3: {
    segments: [
      { id: "q3-question", role: "interviewer", text: "如果要上线这次改动，你会如何灰度和回滚？", finalized: true },
      { id: "q3-answer", role: "candidate", text: "我先放量到 5%，对比新旧版本的错误率和 P95。错误率连续五分钟超过 1% 就停止放量并切回旧版本，回滚后再确认指标恢复。发布和回滚由当班工程师执行。", finalized: true },
    ],
    evaluation: {
      score: 4,
      feedback: "给出了灰度比例、观测指标、回滚阈值和责任人。还需确认数据库变更是否兼容旧版本。",
      evidence: [{ segmentId: "q3-answer", quote: "错误率连续五分钟超过 1% 就停止放量并切回旧版本" }],
      followUp: "如果这次发布同时修改了数据库结构，怎么保证旧版本还能运行？",
      nextQuestionId: null,
    },
  },
};
