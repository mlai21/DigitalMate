import type { DbGoal } from "@/server/db/repositories";
import { formatGoalEvidence, type GoalEvidenceItem } from "@/server/goals/contract";
import { extractJsonObject, type GoalStepCandidate } from "@/server/goals/executor";
import type { LlmClient } from "@/server/llm/types";
import { estimateTokenCount } from "@/server/llm/usage";

export type GoalCriterionStatus = {
  id: string;
  met: boolean;
  evidenceRefs: string[];
  note: string;
};

export type GoalVerifyResult = {
  /** Did this round add real progress (new evidence / report content)? */
  progressed: boolean;
  criteriaStatus: GoalCriterionStatus[];
  /** All success criteria met, each backed by evidence references. */
  allMet: boolean;
  /** Union of evidence references backing met criteria. */
  evidenceRefs: string[];
  summary: string;
  tokensUsed: number;
};

export type VerifyGoalStepInput = {
  goal: DbGoal;
  candidate: GoalStepCandidate;
  /** Evidence accumulated in previous rounds (index only, no executor reasoning). */
  priorEvidence: GoalEvidenceItem[];
  llm: LlmClient;
  model: string;
};

/**
 * Independent verification plane: a separate call with its own prompt that
 * only sees the contract checklist, this round's candidate output, and the
 * accumulated evidence index — never the executor's reasoning. Achievement
 * verdicts are additionally hardened in code: a criterion without evidence
 * references can never count as met.
 */
export async function verifyGoalStep(input: VerifyGoalStepInput): Promise<GoalVerifyResult> {
  const prompt = buildVerifyPrompt(input);
  const raw = await input.llm.completeText({
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    model: input.model,
  });
  const tokensUsed = estimateTokenCount(prompt.system) + estimateTokenCount(prompt.user) + estimateTokenCount(raw);
  return hardenVerifyResult(input, parseVerifyResponse(raw), tokensUsed);
}

function buildVerifyPrompt(input: VerifyGoalStepInput): { system: string; user: string } {
  const criteria = (input.goal.contract.successCriteria ?? [])
    .map((criterion) => `- [${criterion.id}] ${criterion.description}（验证方式：${criterion.verification}）`)
    .join("\n");

  const priorEvidence =
    input.priorEvidence.length > 0
      ? input.priorEvidence.map((item) => `- ${formatGoalEvidence(item)}`).join("\n")
      : "（此前没有已收集的证据）";

  const newEvidence =
    input.candidate.evidence.length > 0
      ? input.candidate.evidence.map((item) => `- ${formatGoalEvidence(item)}`).join("\n")
      : "（本轮没有新增证据）";

  const system = [
    "你是一个长时目标循环的独立验证器。执行器每轮产出候选成果，由你对照完成标准做两级判定。",
    "判定规则：",
    "1. 进展判定：本轮是否新增了实质证据或报告内容？只重复已有信息、或只有叙述没有证据，算无进展。",
    "2. 达成判定：逐项核对完成标准，某项只有在有具体证据（URL 或明确事实来源）支撑时才算满足；『看起来完成了』不算数。",
    "只输出 JSON（不要输出其他内容）：",
    `{
  "progressed": true,
  "criteriaStatus": [{ "id": "标准id", "met": false, "evidenceRefs": ["支撑该标准的 URL 或来源"], "note": "缺口说明" }],
  "allMet": false,
  "summary": "一句话判定结论"
}`,
  ].join("\n");

  const user = [
    `目标：${input.goal.contract.objective ?? input.goal.title}`,
    `完成标准 checklist：\n${criteria || "（合同未定义完成标准）"}`,
    `此前累计证据索引：\n${priorEvidence}`,
    `本轮新增证据：\n${newEvidence}`,
    `本轮候选产出（报告增量）：\n${input.candidate.candidate || "（本轮没有报告增量）"}`,
  ].join("\n\n");

  return { system, user };
}

function parseVerifyResponse(raw: string): Partial<GoalVerifyResult> {
  const parsed = extractJsonObject(raw);
  if (!parsed) return {};

  const criteriaStatus = Array.isArray(parsed.criteriaStatus)
    ? parsed.criteriaStatus
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => ({
          id: typeof item.id === "string" ? item.id : "",
          met: item.met === true,
          evidenceRefs: Array.isArray(item.evidenceRefs)
            ? item.evidenceRefs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
            : [],
          note: typeof item.note === "string" ? item.note : "",
        }))
        .filter((item) => item.id)
    : [];

  return {
    progressed: parsed.progressed === true,
    criteriaStatus,
    allMet: parsed.allMet === true,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
  };
}

/**
 * Code-level hardening of the LLM verdict — the executor never grades its own
 * work, and the verifier's optimism is bounded by these deterministic rules.
 */
function hardenVerifyResult(
  input: VerifyGoalStepInput,
  parsed: Partial<GoalVerifyResult>,
  tokensUsed: number,
): GoalVerifyResult {
  const criteriaStatus = (parsed.criteriaStatus ?? []).map((criterion) => ({
    ...criterion,
    // No evidence references -> not met, regardless of the model's verdict.
    met: criterion.met && criterion.evidenceRefs.length > 0,
  }));

  const contractCriteria = input.goal.contract.successCriteria ?? [];
  const everyCriterionMet =
    contractCriteria.length > 0 &&
    contractCriteria.every((criterion) => criteriaStatus.some((status) => status.id === criterion.id && status.met));

  const hasNewMaterial = input.candidate.evidence.length > 0 || input.candidate.candidate.trim().length > 0;
  const evidenceRefs = [...new Set(criteriaStatus.filter((status) => status.met).flatMap((status) => status.evidenceRefs))];

  return {
    progressed: parsed.progressed === true && hasNewMaterial,
    criteriaStatus,
    allMet: parsed.allMet === true && everyCriterionMet && evidenceRefs.length > 0,
    evidenceRefs,
    summary: parsed.summary ?? "",
    tokensUsed,
  };
}
