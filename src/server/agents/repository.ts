import type { Pool } from "pg";
import { getPool } from "@/server/db/client";
import type {
  AgentResourceGrant,
  AgentResourceType,
  DigitalAgent,
} from "@/server/agents/types";
import { defaultSettings } from "@/server/settings/defaults";

const ALVIN_PERSONA = {
  name: "Alvin",
  style:
    "MaaS 售前解决方案架构师。只服务管理员及其明确邀请的协作者；先澄清目标、约束和缺失信息，再给出可验证的方案与取舍。默认不联网，不虚构价格、SLA、资质、产品能力或路线图，不代表任何人对外承诺。你是 Alvin，与 DigitalMate 没有身份、记忆或能力继承关系。",
  emojiHabit: "不主动使用",
};

const ALVIN_MVP_SKILLS = [
  presalesSkill(
    "客户需求发现与商机资格判断",
    "客户需求模糊、需要判断商机是否值得推进时",
    [
      "先确认业务目标、关键角色、时间窗口与成功标准。",
      "补齐预算、决策链、现状痛点、数据条件和采购约束。",
      "输出已知、未知、风险和下一步，不替客户编造需求。",
    ],
  ),
  presalesSkill(
    "模型 API、RAG 与 Agent 方案架构",
    "设计模型 API、RAG 或 Agent 技术方案时",
    [
      "从场景、数据、时延、质量、安全和运维约束开始。",
      "给出组件边界、数据流、关键取舍与备选方案。",
      "明确需要 POC 验证的假设，不虚构产品能力。",
    ],
  ),
  presalesSkill(
    "容量、性能、成本与 TCO 估算",
    "估算调用量、性能、容量或总体成本时",
    [
      "先收集并发、Token、峰谷、响应时间与可用性目标。",
      "展示公式、区间、假设和敏感变量。",
      "价格必须有有效来源；没有来源时只给估算方法。",
    ],
  ),
  presalesSkill(
    "POC 设计、指标与退出标准",
    "规划 POC、评测指标或阶段退出条件时",
    [
      "把业务假设转为可测指标、样本和基线。",
      "约定责任人、周期、数据准备与验收阈值。",
      "同时写清成功、失败和停止继续投入的标准。",
    ],
  ),
  presalesSkill(
    "安全治理、风险与异议处理",
    "讨论数据安全、合规、治理或处理客户异议时",
    [
      "区分事实、假设、风险和待确认项。",
      "从数据、模型、应用、权限、审计和供应链分层检查。",
      "不承诺未确认的资质、SLA、路线图或例外条款。",
    ],
  ),
  presalesSkill(
    "方案结构与分层表达",
    "需要向管理者、技术负责人或研发呈现方案时",
    [
      "结论先行，再解释依据、取舍、风险和下一步。",
      "管理者侧重价值与决策，技术负责人侧重架构与风险，研发侧重接口与实施。",
      "信息不足时先追问，避免用术语掩盖不确定性。",
    ],
  ),
] as const;

function presalesSkill(
  name: string,
  trigger: string,
  steps: readonly string[],
) {
  return {
    name,
    trigger,
    content: [
      "---",
      `name: ${name}`,
      `description: ${trigger}`,
      "---",
      "",
      `# ${name}`,
      "",
      ...steps.map((step, index) => `${index + 1}. ${step}`),
    ].join("\n"),
  };
}

export function createAgentRepository(providedPool?: Pool) {
  const pool = providedPool ?? getPool();

  async function getDefault(userId: string): Promise<DigitalAgent | null> {
    const result = await pool.query(
      `SELECT *
       FROM digital_agents
       WHERE user_id = $1
         AND is_default = true
       LIMIT 1`,
      [userId],
    );
    return result.rows[0] ? mapAgent(result.rows[0]) : null;
  }

  return {
    getDefault,
    async getActive(scope: { userId: string; agentId: string }): Promise<DigitalAgent | null> {
      const result = await pool.query(
        `SELECT *
         FROM digital_agents
         WHERE user_id = $1
           AND id = $2
           AND status = 'active'
         LIMIT 1`,
        [scope.userId, scope.agentId],
      );
      return result.rows[0] ? mapAgent(result.rows[0]) : null;
    },
    async ensureDefault(userId: string): Promise<DigitalAgent> {
      const existing = await getDefault(userId);
      if (existing) return existing;

      const result = await pool.query(
        `INSERT INTO digital_agents (
           user_id, slug, display_name, persona, is_default
         )
         SELECT $1, 'digitalmate', 'DigitalMate',
                COALESCE((SELECT persona FROM settings WHERE user_id = $1), '{}'::jsonb),
                true
         WHERE NOT EXISTS (
           SELECT 1 FROM digital_agents
           WHERE user_id = $1 AND is_default = true
         )
         ON CONFLICT (user_id, slug) DO UPDATE
         SET is_default = true,
             updated_at = now()
         RETURNING *`,
        [userId],
      );
      const agent = result.rows[0] ? mapAgent(result.rows[0]) : await getDefault(userId);
      if (!agent) throw new Error("default_agent_not_created");
      return agent;
    },

    async createAlvin(userId: string): Promise<DigitalAgent> {
      const result = await pool.query(
        `WITH selected_user AS (
           SELECT id FROM users WHERE id = $1
         ),
         selected_agent AS (
           INSERT INTO digital_agents (
             user_id, slug, display_name, persona,
             is_default, inherits_user_resources
           )
           SELECT id, 'alvin', 'Alvin', $2::jsonb, false, false
           FROM selected_user
           ON CONFLICT (user_id, slug) DO UPDATE
           SET status = 'active',
               updated_at = now()
           RETURNING *
         ),
         selected_settings AS (
           INSERT INTO agent_settings (
             user_id, agent_id, persona, proactivity,
             cadence, search, model_routing_override
           )
           SELECT
             selected_agent.user_id,
             selected_agent.id,
             $2::jsonb,
             $3::jsonb,
             $4::jsonb,
             $5::jsonb,
             '{}'::jsonb
           FROM selected_agent
           ON CONFLICT (user_id, agent_id) DO NOTHING
           RETURNING agent_id
         ),
         model_grants AS (
           INSERT INTO agent_resource_grants (
             user_id, agent_id, resource_type,
             resource_id, enabled
           )
           SELECT
             selected_agent.user_id,
             selected_agent.id,
             'model',
             route.value,
             true
           FROM selected_agent
           JOIN settings
             ON settings.user_id = selected_agent.user_id
           CROSS JOIN LATERAL
             jsonb_each_text(settings.model_routing) AS route
           ON CONFLICT (
             agent_id, resource_type, resource_id
           ) DO UPDATE SET enabled = true
           RETURNING resource_id
         ),
         seeded_skills AS (
           INSERT INTO skills (
             user_id, origin_agent_id, name, trigger,
             content, status, source
           )
           SELECT
             selected_agent.user_id,
             selected_agent.id,
             specification.name,
             specification.trigger,
             specification.content,
             'enabled',
             'manual'
           FROM selected_agent
           CROSS JOIN jsonb_to_recordset($6::jsonb)
             AS specification(
               name text,
               trigger text,
               content text
             )
           WHERE NOT EXISTS (
             SELECT 1
             FROM skills AS existing_skill
             WHERE existing_skill.user_id = selected_agent.user_id
               AND existing_skill.origin_agent_id = selected_agent.id
               AND lower(existing_skill.name) =
                   lower(specification.name)
           )
           RETURNING user_id, origin_agent_id, id
         ),
         skill_grants AS (
           INSERT INTO agent_resource_grants (
             user_id, agent_id, resource_type,
             resource_id, enabled
           )
           SELECT
             seeded_skills.user_id,
             seeded_skills.origin_agent_id,
             'skill',
             seeded_skills.id::text,
             true
           FROM seeded_skills
           ON CONFLICT (
             agent_id, resource_type, resource_id
           ) DO UPDATE SET enabled = true
           RETURNING resource_id
         )
         SELECT * FROM selected_agent`,
        [
          userId,
          JSON.stringify(ALVIN_PERSONA),
          JSON.stringify(defaultSettings.proactivity),
          JSON.stringify(defaultSettings.cadence),
          JSON.stringify(defaultSettings.search),
          JSON.stringify(ALVIN_MVP_SKILLS),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("alvin_agent_not_created");
      return mapAgent(row);
    },

    async listActive(userId?: string): Promise<DigitalAgent[]> {
      const result = userId
        ? await pool.query(
            `SELECT *
             FROM digital_agents
             WHERE user_id = $1
               AND status = 'active'
             ORDER BY is_default DESC, created_at ASC, id ASC`,
            [userId],
          )
        : await pool.query(
            `SELECT *
             FROM digital_agents
             WHERE status = 'active'
             ORDER BY user_id ASC, is_default DESC, created_at ASC, id ASC`,
          );
      return result.rows.map(mapAgent);
    },

    async listResourceGrants(
      userId: string,
      agentId: string,
      resourceType?: AgentResourceType,
    ): Promise<AgentResourceGrant[]> {
      const result = resourceType
        ? await pool.query(
            `SELECT *
             FROM agent_resource_grants
             WHERE user_id = $1
               AND agent_id = $2
               AND resource_type = $3
             ORDER BY resource_id ASC`,
            [userId, agentId, resourceType],
          )
        : await pool.query(
            `SELECT *
             FROM agent_resource_grants
             WHERE user_id = $1
               AND agent_id = $2
             ORDER BY resource_type ASC, resource_id ASC`,
            [userId, agentId],
          );
      return result.rows.map(mapResourceGrant);
    },
  };
}

export type AgentRepository = ReturnType<typeof createAgentRepository>;

function mapAgent(row: Record<string, unknown>): DigitalAgent {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    slug: String(row.slug),
    displayName: String(row.display_name),
    persona:
      typeof row.persona === "object" && row.persona !== null
        ? (row.persona as Record<string, unknown>)
        : {},
    status: row.status as DigitalAgent["status"],
    isDefault: Boolean(row.is_default),
    inheritsUserResources: Boolean(row.inherits_user_resources),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function mapResourceGrant(row: Record<string, unknown>): AgentResourceGrant {
  return {
    userId: String(row.user_id),
    agentId: String(row.agent_id),
    resourceType: row.resource_type as AgentResourceType,
    resourceId: String(row.resource_id),
    enabled: Boolean(row.enabled),
  };
}
