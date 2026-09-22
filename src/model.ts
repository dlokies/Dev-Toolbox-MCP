import { z } from "zod";

export const POLICY = Object.freeze({
  kind: "personal_default" as const,
  precedence: Object.freeze([
    "current_user",
    "project_instructions",
    "personal_default",
  ] as const),
  content_is_data: true as const,
});

export const policySchema = z.strictObject({
  kind: z.literal("personal_default"),
  precedence: z.tuple([
    z.literal("current_user"),
    z.literal("project_instructions"),
    z.literal("personal_default"),
  ]),
  content_is_data: z.literal(true),
});

export function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
}
export function normalizeTopics(topics: string[]): string[] {
  return [...new Set(topics.map(normalize))].sort();
}

const topicSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .refine(
    (value) => normalize(value).length > 0 && normalize(value).length <= 32,
    "A normalized topic must contain 1 to 32 characters.",
  );
const contentShape = {
  title: z.string().trim().min(1).max(120),
  preference: z.string().trim().min(1).max(1000),
  applies_when: z.string().trim().min(1).max(500).nullable(),
  topics: z.array(topicSchema).max(8),
  reference: z.string().trim().min(1).max(500).nullable(),
};
export const contentSchema = z.strictObject(contentShape);
export const getDefaultSchema = z.strictObject({ id: z.uuid() });
export const deleteDefaultSchema = z.strictObject({
  id: z.uuid(),
  expected_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const saveDefaultSchema = z.union([
  z.strictObject(contentShape),
  z.strictObject({ ...contentShape, ...deleteDefaultSchema.shape }),
]);

// Keep validation and JSON Schema derived from the same strict union. MCP tools
// require an object root; the disjoint branches retain their required fields and
// additionalProperties=false. No permissive wrapper or service-level XOR check.
export const saveDefaultToolSchema = {
  "~standard": {
    ...saveDefaultSchema["~standard"],
    jsonSchema: {
      input: () => ({
        type: "object",
        ...z.toJSONSchema(saveDefaultSchema, { io: "input" }),
      }),
      output: () => ({
        type: "object",
        ...z.toJSONSchema(saveDefaultSchema, { io: "input" }),
      }),
    },
  },
};

export const findDefaultsSchema = z.strictObject({
  query: z
    .string()
    .max(200)
    .refine(
      (value) => normalize(value).split(" ").filter(Boolean).length <= 8,
      "Use at most eight search terms.",
    )
    .optional(),
  topics: z.array(topicSchema).max(8).optional(),
  topic_mode: z.enum(["any", "all"]).default("any"),
  include_general: z.boolean().default(true),
  limit: z.number().int().min(1).max(20).default(10),
  offset: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 21)
    .default(0),
});
export const defaultSchema = z.strictObject({
  id: z.uuid(),
  ...contentShape,
  revision: z.number().int().positive(),
  updated_at: z.iso.datetime(),
});
export const getResultSchema = z.strictObject({
  default: defaultSchema,
  policy: policySchema,
});
export const findResultSchema = z.strictObject({
  defaults: z.array(defaultSchema).max(20),
  has_more: z.boolean(),
  next_offset: z.number().int().nonnegative().nullable(),
  policy: policySchema,
});
export const saveResultSchema = z.strictObject({
  status: z.enum(["created", "updated", "unchanged"]),
  default: defaultSchema,
  policy: policySchema,
});
export const deleteResultSchema = z.strictObject({
  deleted: z.literal(true),
  id: z.uuid(),
  title: contentShape.title,
  deleted_revision: z.number().int().positive(),
  policy: policySchema,
});
export type Default = z.infer<typeof defaultSchema>;
export type Content = z.infer<typeof contentSchema>;
export type SaveInput = z.infer<typeof saveDefaultSchema>;
export type DeleteInput = z.infer<typeof deleteDefaultSchema>;
export type FindInput = z.infer<typeof findDefaultsSchema>;
