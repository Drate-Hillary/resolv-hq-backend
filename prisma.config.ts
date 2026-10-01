import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Supabase's `auth` schema is included only because `public.profiles.id`
// has a foreign key into `auth.users` — Prisma requires the referenced
// schema to be introspected too. Supabase owns and migrates that schema
// itself, so every auth.* table is marked external: Prisma Migrate will
// never generate DDL for them, just read their shape for relations/types.
const authTables = [
  'auth.audit_log_entries',
  'auth.custom_oauth_providers',
  'auth.flow_state',
  'auth.identities',
  'auth.instances',
  'auth.mfa_amr_claims',
  'auth.mfa_challenges',
  'auth.mfa_factors',
  'auth.mfa_recovery_code_sets',
  'auth.mfa_recovery_codes',
  'auth.oauth_authorizations',
  'auth.oauth_client_states',
  'auth.oauth_clients',
  'auth.oauth_consents',
  'auth.one_time_tokens',
  'auth.refresh_tokens',
  'auth.saml_providers',
  'auth.saml_relay_states',
  'auth.schema_migrations',
  'auth.scim_tokens',
  'auth.scim_users',
  'auth.sessions',
  'auth.sso_domains',
  'auth.sso_providers',
  'auth.users',
  'auth.webauthn_challenges',
  'auth.webauthn_credentials',
];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  experimental: {
    externalTables: true,
  },
  tables: {
    external: authTables,
  },
});
