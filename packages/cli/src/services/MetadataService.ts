/**
 * MetadataService — unified session metadata operations.
 *
 * Wraps core metadata functions with a sessionsDir bound at construction,
 * providing a cleaner API for commands that work with a single project.
 * Replaces the scattered `readMetadata(filePath)` calls throughout the CLI.
 */

import {
  readMetadata,
  writeMetadata,
  updateMetadata as coreUpdateMetadata,
  deleteMetadata,
  listMetadata,
  readMetadataRaw,
  type SessionMetadata,
} from "@composio/ao-core";

export class MetadataService {
  constructor(private readonly sessionsDir: string) {}

  /** Read typed metadata for a session. */
  read(sessionId: string): SessionMetadata | null {
    return readMetadata(this.sessionsDir, sessionId);
  }

  /** Read raw metadata as key-value pairs (for arbitrary/extension fields). */
  readRaw(sessionId: string): Record<string, string> | null {
    return readMetadataRaw(this.sessionsDir, sessionId);
  }

  /** Write full metadata for a session (overwrites). */
  write(sessionId: string, metadata: SessionMetadata): void {
    writeMetadata(this.sessionsDir, sessionId, metadata);
  }

  /** Atomically update specific fields (read-merge-write). */
  update(sessionId: string, updates: Partial<Record<string, string>>): void {
    coreUpdateMetadata(this.sessionsDir, sessionId, updates);
  }

  /** Delete metadata, optionally archiving it first. */
  delete(sessionId: string, archive = true): void {
    deleteMetadata(this.sessionsDir, sessionId, archive);
  }

  /** List all session IDs that have metadata files. */
  list(): string[] {
    return listMetadata(this.sessionsDir);
  }

  /**
   * Find an active session working on a given issue.
   * Only considers sessions that exist in the provided activeSessions list.
   */
  findByIssue(
    issueId: string,
    activeSessions: string[],
    projectId?: string,
  ): string | null {
    const lower = issueId.toLowerCase();
    const sessions = this.list();
    for (const id of sessions) {
      if (!activeSessions.includes(id)) continue;
      const meta = this.read(id);
      if (projectId && meta?.project !== projectId) continue;
      if (meta?.issue && meta.issue.toLowerCase() === lower) {
        return id;
      }
    }
    return null;
  }

  /** Get the underlying sessions directory path. */
  getSessionsDir(): string {
    return this.sessionsDir;
  }
}
