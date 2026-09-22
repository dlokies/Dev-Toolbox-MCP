import { ToolboxError } from "./errors";
import {
  defaultSchema,
  normalize,
  normalizeTopics,
  POLICY,
  type Content,
  type Default,
  type DeleteInput,
  type FindInput,
  type SaveInput,
} from "./model";

type Row = Omit<Default, "topics"> & { topics: string };
const COLUMNS =
  "id, title, preference, applies_when, topics, reference, revision, updated_at";

function entry(row: Row): Default {
  return defaultSchema.parse({ ...row, topics: JSON.parse(row.topics) });
}
function missingOrConflict(
  row: Row | undefined,
  expectedRevision: number,
): Row {
  if (!row)
    throw new ToolboxError("NOT_FOUND", "The personal default does not exist.");
  if (row.revision !== expectedRevision) {
    throw new ToolboxError(
      "REVISION_CONFLICT",
      "The personal default changed. Read its current revision before retrying.",
    );
  }
  return row;
}

export class DefaultRepository {
  constructor(private readonly db: D1Database) {}

  async get({ id }: { id: string }) {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM defaults WHERE id = ?`)
      .bind(id)
      .first<Row>();
    if (!row)
      throw new ToolboxError(
        "NOT_FOUND",
        "The personal default does not exist.",
      );
    return { default: entry(row), policy: POLICY };
  }

  async find(input: FindInput) {
    const clauses: string[] = [];
    const bindings: (string | number)[] = [];
    for (const term of normalize(input.query ?? "")
      .split(" ")
      .filter(Boolean)) {
      clauses.push("instr(search_text, ?) > 0");
      bindings.push(term);
    }
    const topics = normalizeTopics(input.topics ?? []);
    if (topics.length) {
      const matches = topics.map(
        () =>
          "EXISTS (SELECT 1 FROM json_each(defaults.topics) WHERE value = ?)",
      );
      let topicClause = `(${matches.join(input.topic_mode === "all" ? " AND " : " OR ")})`;
      if (input.include_general)
        topicClause = `(${topicClause} OR json_array_length(topics) = 0)`;
      clauses.push(topicClause);
      bindings.push(...topics);
    }
    const result = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM defaults ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY title COLLATE NOCASE, id LIMIT ? OFFSET ?`,
      )
      .bind(...bindings, input.limit + 1, input.offset)
      .all<Row>();
    const hasMore = result.results.length > input.limit;
    return {
      defaults: result.results.slice(0, input.limit).map(entry),
      has_more: hasMore,
      next_offset: hasMore ? input.offset + input.limit : null,
      policy: POLICY,
    };
  }

  async save(input: SaveInput) {
    const content: Content = {
      title: input.title,
      preference: input.preference,
      applies_when: input.applies_when,
      topics: normalizeTopics(input.topics),
      reference: input.reference,
    };
    const topics = JSON.stringify(content.topics);
    const searchText = normalize(
      [
        content.title,
        content.preference,
        content.applies_when ?? "",
        ...content.topics,
      ].join("\n"),
    );
    const values = [
      content.title,
      content.preference,
      content.applies_when,
      topics,
      content.reference,
    ];
    const updatedAt = new Date().toISOString();
    if (!("id" in input)) {
      const row = await this.db
        .prepare(
          `INSERT INTO defaults (id, title, preference, applies_when, topics, reference, revision, updated_at, search_text) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING ${COLUMNS}`,
        )
        .bind(crypto.randomUUID(), ...values, updatedAt, searchText)
        .first<Row>();
      if (!row)
        throw new ToolboxError(
          "INTERNAL_ERROR",
          "The personal default could not be saved.",
        );
      return {
        status: "created" as const,
        default: entry(row),
        policy: POLICY,
      };
    }
    // D1 batch is transactional. The fallback read distinguishes no-op, missing
    // ID and stale revision in the same transaction as the conditional update.
    const [changed, current] = await this.db.batch<Row>([
      this.db
        .prepare(
          `UPDATE defaults SET title = ?, preference = ?, applies_when = ?, topics = ?, reference = ?, revision = revision + 1, updated_at = ?, search_text = ? WHERE id = ? AND revision = ? AND NOT (title IS ? AND preference IS ? AND applies_when IS ? AND topics IS ? AND reference IS ?) RETURNING ${COLUMNS}`,
        )
        .bind(
          ...values,
          updatedAt,
          searchText,
          input.id,
          input.expected_revision,
          ...values,
        ),
      this.db
        .prepare(`SELECT ${COLUMNS} FROM defaults WHERE id = ?`)
        .bind(input.id),
    ]);
    const updated = changed?.results[0];
    if (updated)
      return {
        status: "updated" as const,
        default: entry(updated),
        policy: POLICY,
      };
    const unchanged = missingOrConflict(
      current?.results[0],
      input.expected_revision,
    );
    return {
      status: "unchanged" as const,
      default: entry(unchanged),
      policy: POLICY,
    };
  }

  async delete(input: DeleteInput) {
    const [deleted, current] = await this.db.batch<Row>([
      this.db
        .prepare(
          `DELETE FROM defaults WHERE id = ? AND revision = ? RETURNING ${COLUMNS}`,
        )
        .bind(input.id, input.expected_revision),
      this.db
        .prepare(`SELECT ${COLUMNS} FROM defaults WHERE id = ?`)
        .bind(input.id),
    ]);
    const row = deleted?.results[0];
    if (!row) {
      missingOrConflict(current?.results[0], input.expected_revision);
      throw new ToolboxError(
        "INTERNAL_ERROR",
        "The personal default could not be deleted.",
      );
    }
    return {
      deleted: true as const,
      id: row.id,
      title: row.title,
      deleted_revision: row.revision,
      policy: POLICY,
    };
  }
}
