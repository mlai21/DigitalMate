import type { z } from "zod";

export type ChannelFieldKind =
  | "boolean"
  | "number"
  | "object"
  | "secret"
  | "select"
  | "string"
  | "string-list";

export type ChannelFieldOption = {
  label: string;
  value: boolean | number | string;
};

export type ChannelConfigField = {
  name: string;
  label: string;
  kind: ChannelFieldKind;
  default: boolean | number | string | string[] | null | Record<string, unknown>;
  readonly?: boolean;
  required?: boolean;
  options?: readonly ChannelFieldOption[];
};

export type ChannelConditionPredicate = {
  field: string;
  equals: boolean | number | string;
};

export type ChannelFormCondition =
  | {
      field: string;
      when: ChannelConditionPredicate;
    }
  | {
      fields: readonly string[];
      when: ChannelConditionPredicate;
    }
  | {
      fields: readonly string[];
      whenAny: readonly ChannelConditionPredicate[];
    };

export type ChannelCapability =
  | "attachments"
  | "groups"
  | "streaming"
  | "typing";

export type ChannelRuntimeKind =
  | "central"
  | "gateway"
  | "media"
  | "node";

export type ChannelManifest<TType extends string = string> = {
  type: TType;
  label: string;
  description: string;
  runtime: ChannelRuntimeKind;
  capabilities: readonly ChannelCapability[];
  prerequisites: readonly string[];
  fields: readonly ChannelConfigField[];
  secretFields: readonly string[];
  conditions: readonly ChannelFormCondition[];
  configSchema: z.ZodType<Record<string, unknown>>;
};
