import { eq, sql } from 'drizzle-orm';
import type {
  TeamContextInvalidationCategory,
  TeamContextSnapshot,
} from '../team-context/types.js';
import type { Database } from './database.js';
import { teamContextSnapshots } from './schema.js';

export interface TeamContextStore {
  load(documentToken: string): Promise<TeamContextSnapshot | undefined>;
  accept(snapshot: TeamContextSnapshot): Promise<void>;
  invalidate(
    documentToken: string,
    category: TeamContextInvalidationCategory,
  ): Promise<void>;
}

export class PostgresTeamContextStore implements TeamContextStore {
  constructor(private readonly db: Database) {}

  async load(documentToken: string): Promise<TeamContextSnapshot | undefined> {
    const [row] = await this.db.select().from(teamContextSnapshots)
      .where(eq(teamContextSnapshots.documentToken, documentToken));
    if (!row
      || row.sourceRevision === null
      || row.normalizedContent === null
      || row.estimatedTokens === null
      || row.fetchedAt === null) return undefined;
    return {
      documentToken: row.documentToken,
      sourceRevision: row.sourceRevision,
      normalizedContent: row.normalizedContent,
      estimatedTokens: row.estimatedTokens,
      fetchedAt: row.fetchedAt,
    };
  }

  async accept(snapshot: TeamContextSnapshot): Promise<void> {
    const accepted = await this.db.execute(sql`
      insert into team_context_snapshots (
        document_token, source_revision, normalized_content,
        estimated_tokens, fetched_at, invalidated_at,
        invalidation_category, updated_at
      ) values (
        ${snapshot.documentToken}, ${snapshot.sourceRevision}, ${snapshot.normalizedContent},
        ${snapshot.estimatedTokens}, ${snapshot.fetchedAt}, null, null, now()
      )
      on conflict (document_token) do update set
        source_revision = excluded.source_revision,
        normalized_content = excluded.normalized_content,
        estimated_tokens = excluded.estimated_tokens,
        fetched_at = excluded.fetched_at,
        invalidated_at = null,
        invalidation_category = null,
        updated_at = now()
      where team_context_snapshots.source_revision is null
         or excluded.source_revision >= team_context_snapshots.source_revision
      returning document_token
    `);
    if (accepted.rows.length !== 1) throw new Error('team_context_snapshot_stale');
  }

  async invalidate(
    documentToken: string,
    category: TeamContextInvalidationCategory,
  ): Promise<void> {
    await this.db.insert(teamContextSnapshots).values({
      documentToken,
      sourceRevision: null,
      normalizedContent: null,
      estimatedTokens: null,
      fetchedAt: null,
      invalidatedAt: new Date(),
      invalidationCategory: category,
    }).onConflictDoUpdate({
      target: teamContextSnapshots.documentToken,
      set: {
        sourceRevision: null,
        normalizedContent: null,
        estimatedTokens: null,
        fetchedAt: null,
        invalidatedAt: new Date(),
        invalidationCategory: category,
        updatedAt: new Date(),
      },
    });
  }
}
