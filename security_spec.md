# Security Specification & Payload-First TDD

## 1. Data Invariants
1. **Strict Ownership & Master Gate**: Every subcollection document under `/users/{userId}/...` belongs exclusively to the verified Firebase user (`request.auth.uid == userId && request.auth.token.email_verified == true`), and every subcollection write/get verifies the parent `/users/{userId}` document exists via `get()`.
2. **No Unverified or Cross-Tenant Reads/Writes**: Unauthenticated users and users with `email_verified != true` have zero read/write access to any collection. `allow list` rules explicitly enforce `resource.data.ownerId == request.auth.uid` without `get()` lookups.
3. **Referential & Identity Integrity**:
   - All created/updated documents enforce `ownerId == request.auth.uid` (and `uid == request.auth.uid` on `/users/{userId}`).
   - `ownerId` and `createdAt` are immutable once created (`incoming().ownerId == existing().ownerId`, `incoming().createdAt == existing().createdAt`).
   - Creating a `Message` requires the referenced `lead_id` to exist under `/users/{userId}/leads/{lead_id}` (`exists()`).
   - Creating a `LeadEvent` requires the referenced `lead_id` to exist under `/users/{userId}/leads/{lead_id}` (`exists()`).
   - Creating a `SendLog` requires both `lead_id` and `message_id` to exist under `/users/{userId}/leads/...` and `/users/{userId}/messages/...`.
4. **Temporal Integrity**: `createdAt == request.time` on `create`; `updatedAt == request.time` on `create` and `update`.
5. **Terminal State Locking**:
   - Once a `Message` reaches terminal status `sent`, updates to `subject`, `body`, `status`, `lead_id`, `campaign_id`, or `gmail_id` are rejected forever.
   - Once a `Campaign` reaches `archived`, updates are rejected.
   - `LeadEvent`, `SendLog`, and `AuditLog` are append-only immutable logs (`allow update, delete: if false`).
6. **Native Types & Anti-Poisoning Bounds**:
   - All document IDs match `^[a-zA-Z0-9_\-]+$` and length `<= 128`.
   - Every string field enforces strict `.size()` bounds matching `firebase-blueprint.json`.
   - `Campaign.config`, `Lead.research`, `Lead.score_reason`, `LeadEvent.detail`, and `AuditLog.detail` are stored as native Firestore maps (`is map`), never JSON strings.
   - Strict key allowlisting (`keys().hasAll(...) && keys().hasOnly(...)` on `create`, and `affectedKeys().hasOnly(...)` per named action on `update`).

## 2. The "Dirty Dozen" Attack Payloads
1. **Cross-Tenant Read/Write**: User B (`uid_B`) attempts to read or create `/users/uid_A/leads/lead_1`. -> `PERMISSION_DENIED`.
2. **Unverified Email Spoof**: User A with `email_verified: false` attempts to create `/users/uid_A/campaigns/camp_1`. -> `PERMISSION_DENIED`.
3. **Shadow Ghost Field Injection**: User A creates `/users/uid_A/leads/lead_1` with an extra `{ isAdmin: true }` or `{ role: "superadmin" }` ghost key. -> `PERMISSION_DENIED` (blocked by `keys().hasOnly(...)`).
4. **OwnerId Impersonation**: User A creates `/users/uid_A/leads/lead_1` with `{ ownerId: "uid_B" }`. -> `PERMISSION_DENIED`.
5. **ID Poisoning (Resource Exhaustion)**: User A writes to `/users/uid_A/leads/${"a".repeat(200)}` or `/users/uid_A/leads/bad$id!`. -> `PERMISSION_DENIED` (blocked by `isValidId()`).
6. **Client-Forged Timestamp**: User A creates `/users/uid_A/campaigns/camp_1` with a past client timestamp (`createdAt: Timestamp(2020-01-01)`) instead of `request.time`. -> `PERMISSION_DENIED`.
7. **Terminal Message Mutation**: User A attempts to edit `subject`, `body`, or `status` of a `Message` whose existing status is already `sent`. -> `PERMISSION_DENIED`.
8. **Immutable Audit/SendLog Tampering**: User A attempts to `update` or `delete` an entry in `/users/uid_A/sendLogs/log_1` or `/users/uid_A/auditLogs/audit_1`. -> `PERMISSION_DENIED`.
9. **Orphaned Message Creation**: User A creates a `Message` referencing a non-existent `lead_id: "missing_lead"`. -> `PERMISSION_DENIED` (blocked by `exists()` check).
10. **JSON-String / Type Poisoning**: User A sets `Lead.research` to a raw string or sets `Lead.score` to `"100"` (string) or `999` (out of range `0..100`). -> `PERMISSION_DENIED`.
11. **Value Poisoning / Oversized Payload**: User A sets `KnowledgeEntry.content` to a 60,000-char string (exceeding `maxLength: 50000`) or `Lead.business` to 500 chars. -> `PERMISSION_DENIED`.
12. **Blanket Unscoped List**: Any user issues a list query without `ownerId == request.auth.uid` on another user's subcollection path. -> `PERMISSION_DENIED`.
