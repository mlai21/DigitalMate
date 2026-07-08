import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";

type ManagedStatus = "pending" | "enabled" | "disabled" | "rejected";

export function SkillStatusActions({ skillId, status }: { skillId: string; status: ManagedStatus }) {
  return (
    <StatusActions
      action="/api/admin/skills/status"
      idName="skillId"
      idValue={skillId}
      status={status}
      messages={{
        enable: "确定启用这个 Skill 吗？启用后 DigitalMate 会在后续对话中参考它。",
        disable: "确定停用这个 Skill 吗？停用后不会再自动参考。",
        reject: "确定拒绝这个 Skill 草稿吗？拒绝后不会生效。",
      }}
    />
  );
}

export function ToolRegistrationStatusActions({ toolId, status }: { toolId: string; status: ManagedStatus }) {
  return (
    <StatusActions
      action="/api/admin/tool-registrations/status"
      idName="toolId"
      idValue={toolId}
      status={status}
      messages={{
        enable: "确定启用这个工具吗？启用后 Agent 可在后台调用它。",
        disable: "确定停用这个工具吗？停用后 Agent 不会再调用它。",
        reject: "确定拒绝这个工具草稿吗？拒绝后不会生效。",
      }}
    />
  );
}

function StatusActions({
  action,
  idName,
  idValue,
  status,
  messages,
}: {
  action: string;
  idName: string;
  idValue: string;
  status: ManagedStatus;
  messages: {
    enable: string;
    disable: string;
    reject: string;
  };
}) {
  return (
    <form action={action} method="post">
      <input type="hidden" name={idName} value={idValue} />
      {status === "enabled" ? (
        <ConfirmSubmitButton
          className="secondary-button compact"
          confirmMessage={messages.disable}
          name="status"
          value="disabled"
        >
          停用
        </ConfirmSubmitButton>
      ) : null}
      {status === "disabled" ? (
        <ConfirmSubmitButton className="primary-button compact" confirmMessage={messages.enable} name="status" value="enabled">
          重新启用
        </ConfirmSubmitButton>
      ) : null}
      {status === "pending" ? (
        <ConfirmSubmitButton className="primary-button compact" confirmMessage={messages.enable} name="status" value="enabled">
          启用
        </ConfirmSubmitButton>
      ) : null}
      {status !== "rejected" ? (
        <ConfirmSubmitButton className="danger-button" confirmMessage={messages.reject} name="status" value="rejected">
          拒绝
        </ConfirmSubmitButton>
      ) : null}
    </form>
  );
}
