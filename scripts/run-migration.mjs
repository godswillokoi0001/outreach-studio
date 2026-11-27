// Try every known Supabase endpoint for executing SQL.
//
// Secrets are read from the environment and are never hardcoded here, so this
// file is safe to commit. Run it with:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/run-migration.mjs

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this script.");
  process.exit(1);
}

const SQL =
  process.env.MIGRATION_SQL?.trim() ||
  'ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS include_opt_out_footer BOOLEAN NOT NULL DEFAULT false;';

async function tryEndpoint(url, method, headers, body, label) {
  try {
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    console.log(`${label}: ${res.status} - ${text.slice(0, 200)}`);
    return res.ok;
  } catch (e) {
    console.log(`${label}: Error - ${e.message}`);
    return false;
  }
}

async function main() {
  const authHeaders = {
    'Content-Type': 'application/json',
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
  };

  // Try various SQL execution endpoints
  const endpoints = [
    { url: `${SUPABASE_URL}/pg`, method: 'POST', body: { query: SQL } },
    { url: `${SUPABASE_URL}/pg/query`, method: 'POST', body: { query: SQL } },
    { url: `${SUPABASE_URL}/graphql/v1`, method: 'POST', body: { query: `mutation { sql(query: "${SQL}") }` } },
  ];

  for (const ep of endpoints) {
    if (await tryEndpoint(ep.url, ep.method, authHeaders, ep.body, ep.url)) {
      console.log('✅ Success!');
      return;
    }
  }

  // Check the information_schema to see what tables and columns exist
  console.log('\n--- Checking current settings table columns via PostgREST ---');
  
  // List all columns using the openapi spec
  const schemaRes = await fetch(`${SUPABASE_URL}/rest/v1/?apikey=${SERVICE_KEY}`, {
    headers: authHeaders,
  });
  if (schemaRes.ok) {
    const schema = await schemaRes.json();
    const settingsDef = schema?.definitions?.settings;
    if (settingsDef) {
      console.log('\nCurrent settings table columns:');
      for (const [col, def] of Object.entries(settingsDef.properties || {})) {
        console.log(`  ${col}: ${def.type || def.format || 'unknown'}`);
      }
      
      if (settingsDef.properties?.include_opt_out_footer) {
        console.log('\n✅ Column include_opt_out_footer already exists!');
        return;
      }
    }
  }

  // Check the OpenAPI spec
  console.log('\n--- Checking OpenAPI spec ---');
  const openApiRes = await fetch(`${SUPABASE_URL}/rest/v1/`, {
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Accept': 'application/openapi+json',
    },
  });
  if (openApiRes.ok) {
    const spec = await openApiRes.json();
    const paths = Object.keys(spec.paths || {});
    console.log('Available paths:', paths.slice(0, 20));
    
    const settingsSpec = spec.definitions?.settings;
    if (settingsSpec?.properties) {
      const cols = Object.keys(settingsSpec.properties);
      console.log('\nSettings columns from OpenAPI:', cols);
      if (cols.includes('include_opt_out_footer')) {
        console.log('\n✅ Column include_opt_out_footer already exists!');
        return;
      }
    }
  }

  console.log('\n❌ No SQL execution endpoint available. Column does not exist yet.');
  console.log('Please run in Supabase SQL Editor:');
  console.log(SQL);
}

main().catch(console.error);
