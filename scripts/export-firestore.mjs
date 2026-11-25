// One-off export of the app's Firestore data, used to seed Supabase.
// Usage: node scripts/export-firestore.mjs
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { JWT } from "google-auth-library";

const config = JSON.parse(readFileSync("firebase-applet-config.json", "utf8"));
const creds = JSON.parse(readFileSync("firebase-service-account.json", "utf8"));
const projectId = config.projectId;
const databaseId = config.firestoreDatabaseId || "(default)";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "censusokoi515@gmail.com";

const auth = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/datastore",
  ],
});

const token = (await auth.getAccessToken()).token;
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${encodeURIComponent(databaseId)}/documents`;

function decodeValue(value) {
  if (!value || typeof value !== "object") return null;
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("stringValue" in value) return value.stringValue;
  if ("bytesValue" in value) return value.bytesValue;
  if ("referenceValue" in value) return value.referenceValue;
  if ("geoPointValue" in value) return value.geoPointValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) out[key] = decodeValue(value);
  return out;
}

async function listUsers() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:batchGet?maxResults=1000`,
    { headers },
  );
  if (!res.ok) throw new Error(`listUsers failed ${res.status}: ${await res.text()}`);
  return (await res.json()).users || [];
}

async function listDocs(path) {
  const docs = [];
  let pageToken;
  do {
    const url = new URL(`${base}/${path}`);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers });
    if (res.status === 404) return docs;
    if (!res.ok) throw new Error(`list ${path} failed ${res.status}: ${await res.text()}`);
    const json = await res.json();
    for (const doc of json.documents || []) {
      const id = doc.name.split("/").pop();
      docs.push({ id, ...decodeFields(doc.fields) });
    }
    pageToken = json.nextPageToken;
  } while (pageToken);
  return docs;
}

async function listCollectionIds(path) {
  const url = `${base}/${path}:listCollectionIds`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ pageSize: 300 }) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`listCollections ${path} failed ${res.status}: ${await res.text()}`);
  return (await res.json()).collectionIds || [];
}

const users = await listUsers();
console.log(`Found ${users.length} Firebase user(s):`);
for (const u of users) console.log(`  ${u.localId}  ${u.email || "(none)"}`);

const owner = users.find((u) => (u.email || "").toLowerCase() === OWNER_EMAIL.toLowerCase());
if (!owner) throw new Error(`No Firebase user with email ${OWNER_EMAIL}`);
console.log(`\nExporting data owned by ${OWNER_EMAIL} (uid ${owner.localId})`);

const userRoot = `users/${owner.localId}`;
const collections = await listCollectionIds(userRoot);
console.log(`Collections: ${collections.join(", ") || "(none)"}`);

const data = { ownerEmail: OWNER_EMAIL, ownerId: owner.localId, exportedAt: new Date().toISOString(), collections: {} };
for (const name of collections) {
  const docs = await listDocs(`${userRoot}/${name}`);
  data.collections[name] = docs;
  console.log(`  ${name}: ${docs.length}`);
}

const rootCollections = await listCollectionIds("");
if (rootCollections.length) {
  console.log(`Root collections: ${rootCollections.join(", ")}`);
  for (const name of rootCollections) {
    const docs = await listDocs(name);
    if (!docs.length) continue;
    if (docs.some((d) => typeof d.ownerId === "string" && d.ownerId !== owner.localId)) {
      console.log(`  ${name}: skipped (shared, ${docs.length} docs)`);
      continue;
    }
    data.collections[name] = docs;
    console.log(`  ${name}: ${docs.length}`);
  }
}

mkdirSync("migration-export", { recursive: true });
const out = "migration-export/firestore.json";
writeFileSync(out, JSON.stringify(data, null, 2));
console.log(`\nWrote ${out}`);
for (const [name, docs] of Object.entries(data.collections)) console.log(`  ${name}: ${docs.length}`);
