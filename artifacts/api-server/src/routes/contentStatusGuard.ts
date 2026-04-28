import { Router, type IRouter, type Request } from "express";
import { eq } from "drizzle-orm";
import { db, contentSubmissionsTable } from "@workspace/db";
import { serializeRow } from "../lib/serialize";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";

const router: IRouter = Router();

function hasAdminAuth(req: Request): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) return false;
  return req.headers.authorization === `Bearer ${adminSecret}`;
}

function safeUserSubmissionRow(row: Record<string, unknown>): Record<string, unknown> {
  const safe = { ...row };
  delete safe.adminNotes;
  delete safe.reviewedBy;
  return safe;
}

// This route intentionally mounts before the broader content router. It fixes
// the IDOR risk in /content/status/:submissionId by requiring either:
// - admin bearer auth, or
// - authenticated ownership via Telegram init data + telegramId query.
router.get("/content/status/:submissionId", async (req, res): Promise<void> => {
  const submissionId = parseInt(req.params.submissionId ?? "", 10);
  if (!Number.isInteger(submissionId)) {
    res.status(400).json({ error: "Invalid submission ID." });
    return;
  }

  const [submission] = await db
    .select()
    .from(contentSubmissionsTable)
    .where(eq(contentSubmissionsTable.id, submissionId))
    .limit(1);

  if (!submission) {
    res.status(404).json({ error: "Submission not found." });
    return;
  }

  if (hasAdminAuth(req)) {
    res.json(serializeRow(submission as Record<string, unknown>));
    return;
  }

  const queryTelegramId = typeof req.query.telegramId === "string" ? req.query.telegramId : "";
  if (!queryTelegramId) {
    res.status(401).json({ error: "Authentication required. Pass telegramId and Telegram init data." });
    return;
  }

  const authedId = resolveAuthenticatedTelegramId(req, res, queryTelegramId);
  if (!authedId) return;

  if (submission.telegramId !== authedId) {
    res.status(403).json({ error: "You can only view your own creator submission." });
    return;
  }

  res.json(safeUserSubmissionRow(serializeRow(submission as Record<string, unknown>)));
});

export default router;
