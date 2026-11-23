import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rulesPath = path.join(process.cwd(), "firestore.rules");
const blueprintPath = path.join(process.cwd(), "firebase-blueprint.json");

const rulesText = fs.readFileSync(rulesPath, "utf8");
const blueprint = JSON.parse(fs.readFileSync(blueprintPath, "utf8")) as {
  entities: Record<string, { properties: Record<string, { maxLength?: number; pattern?: string }> }>;
  firestore: Record<string, unknown>;
};

test("firestore.rules declares rules_version 2 and default-deny safety net", () => {
  assert.match(rulesText, /^rules_version = '2';/m);
  assert.match(rulesText, /match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
});

test("every collection in firebase-blueprint.json has an explicit match block in firestore.rules", () => {
  const paths = Object.keys(blueprint.firestore);
  const expectedSegments = [
    "match /users/{userId}",
    "match /settings/{settingId}",
    "match /knowledge/{entryId}",
    "match /knowledgeSources/{sourceId}",
    "match /campaigns/{campaignId}",
    "match /leads/{leadId}",
    "match /leadEvents/{eventId}",
    "match /messages/{messageId}",
    "match /replies/{replyId}",
    "match /suppressions/{suppressionId}",
    "match /sendLogs/{logId}",
    "match /auditLogs/{logId}",
  ];
  assert.equal(paths.length, expectedSegments.length);
  for (const segment of expectedSegments) {
    assert.ok(rulesText.includes(segment), `Missing match block for ${segment}`);
  }
});

test("Dirty Dozen security invariants are enforced in firestore.rules", () => {
  // 1 & 2: Verified email + owner check
  assert.ok(rulesText.includes("request.auth != null && request.auth.token.email_verified == true"));
  assert.ok(rulesText.includes("request.auth.uid == userId"));

  // 3: Shadow ghost field prevention via hasAll + hasOnly + affectedKeys().hasOnly
  assert.ok(rulesText.includes("keys().hasOnly("));
  assert.ok(rulesText.includes("affectedKeys().hasOnly("));

  // 4 & 5: Identity & ID poisoning guard
  assert.ok(rulesText.includes("isValidId("));
  assert.ok(rulesText.includes("^[a-zA-Z0-9_\\\\-]+$"));

  // 6: Temporal integrity via request.time
  assert.ok(rulesText.includes("incoming().createdAt == request.time"));
  assert.ok(rulesText.includes("incoming().updatedAt == request.time"));

  // 7: Terminal state locks on sent messages & archived campaigns
  assert.ok(rulesText.includes("existing().status != 'sent'"));
  assert.ok(rulesText.includes("existing().status != 'archived'"));

  // 8: Immutable logs
  assert.ok(rulesText.includes("allow update: if false;"));
  assert.ok(rulesText.includes("allow update, delete: if false;"));

  // 9: Referential exists() checks on messages & sendLogs
  assert.ok(rulesText.includes("leads/$(incoming().lead_id)"));
  assert.ok(rulesText.includes("messages/$(incoming().message_id)"));

  // 10 & 11: Native maps and blueprint maxLength sync
  assert.ok(rulesText.includes("isOptMap(data, 'research')"));
  assert.ok(rulesText.includes("isValidCampaignConfig(data.config)"));
  const maxKnowledge = blueprint.entities.KnowledgeEntry.properties.content.maxLength;
  assert.ok(rulesText.includes(String(maxKnowledge)));

  // 12: Secure allow list with resource.data ownerId check and zero get() inside list
  const listLines = rulesText.split("\n").filter((line) => line.includes("allow list:"));
  assert.ok(listLines.length >= 10);
  for (const line of listLines) {
    assert.ok(!line.includes("get("), `allow list must not call get(): ${line}`);
    assert.ok(
      line.includes("if false;") || line.includes("existing().ownerId == request.auth.uid"),
      `allow list must enforce ownerId: ${line}`,
    );
  }
});
