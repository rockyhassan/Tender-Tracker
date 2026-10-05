import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnvFile } from "./postgres";

let clientInstance: SupabaseClient | null = null;

export interface SupabaseConfig {
  url?: string;
  key?: string;
  isConfigured: boolean;
}

/**
 * Returns whether Supabase client configuration is present.
 */
export function getSupabaseConfig(): SupabaseConfig {
  loadEnvFile();
  let url = process.env.SUPABASE_URL;
  if (!url && process.env.DATABASE_URL) {
    const match = process.env.DATABASE_URL.match(/postgres\.([a-z0-9_-]+):/i);
    if (match?.[1]) {
      url = `https://${match[1]}.supabase.co`;
    }
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  return {
    url,
    key,
    isConfigured: Boolean(url && key),
  };
}

/**
 * Returns a singleton SupabaseClient if environment variables are set.
 * Returns null if not configured, rather than throwing at module load time.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (clientInstance) return clientInstance;

  const { url, key, isConfigured } = getSupabaseConfig();
  if (!isConfigured || !url || !key) {
    return null;
  }

  clientInstance = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return clientInstance;
}

/**
 * Resets the client singleton (useful for testing or when credentials are updated).
 */
export function resetSupabaseClient(): void {
  clientInstance = null;
}

/**
 * Ensures a private Supabase Storage bucket exists.
 */
export async function ensureStorageBucket(
  client: SupabaseClient,
  bucketName = "documents",
  options: { isPublic?: boolean } = { isPublic: false }
): Promise<void> {
  const { data: buckets, error: listError } = await client.storage.listBuckets();
  if (listError) {
    // If listBuckets fails, try direct getBucket
    const { data: bucket, error: getError } = await client.storage.getBucket(bucketName);
    if (!bucket || getError) {
      const { error: createError } = await client.storage.createBucket(bucketName, {
        public: options.isPublic ?? false,
      });
      if (createError && !createError.message.toLowerCase().includes("already exists")) {
        throw createError;
      }
    }
    return;
  }

  const existing = buckets?.find((b) => b.name === bucketName || b.id === bucketName);
  if (!existing) {
    const { error: createError } = await client.storage.createBucket(bucketName, {
      public: options.isPublic ?? false,
    });
    if (createError && !createError.message.toLowerCase().includes("already exists")) {
      throw createError;
    }
  }
}

