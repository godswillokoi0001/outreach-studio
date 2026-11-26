/**
 * Idempotent CLI seed script for `global_knowledge_modules`.
 * Usage:
 *   npx tsx --env-file=.env.local scripts/seed-global-knowledge.ts
 *   npx tsx --env-file=.env.local scripts/seed-global-knowledge.ts --force
 */
import { ensureGlobalKnowledgeSeeded } from "../lib/global-knowledge/service";

async function main() {
  const force = process.argv.includes("--force");
  console.log(`[seed-global-knowledge] Starting idempotent seed (force=${force})...`);
  const result = await ensureGlobalKnowledgeSeeded({ force });
  console.log("[seed-global-knowledge] Result:", JSON.stringify(result));
  if (result.fallback) {
    console.error(
      "[seed-global-knowledge] Database table global_knowledge_modules was unreachable or not migrated yet.",
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[seed-global-knowledge] Failed:", err);
  process.exit(1);
});
