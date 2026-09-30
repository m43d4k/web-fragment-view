import { DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Database, ObjectStore } from './engine';

interface CloudflareConfig {
  accountId: string;
  databaseId: string;
  apiToken: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function remoteAdapters(config: CloudflareConfig): { db: Database; objects: ObjectStore } {
  const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com`;
  const s3 = new S3Client({
    region: 'auto', endpoint, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const db: Database = {
    async query<T>(sql: string, params: unknown[] = []) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql, params }),
        },
      );
      if (!response.ok) throw new Error(`D1 query failed with HTTP ${response.status}`);
      const payload = await response.json() as {
        success: boolean;
        result?: { success: boolean; results: T[]; meta?: { changes?: number } }[];
      };
      const result = payload.result?.[0];
      if (!payload.success || !result?.success) throw new Error('D1 query failed');
      return { results: result.results ?? [], changes: result.meta?.changes ?? 0 };
    },
  };
  const objects: ObjectStore = {
    async head(key) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: config.bucketName, Key: key }));
        return true;
      } catch (error) {
        if (typeof error === 'object' && error !== null && '$metadata' in error &&
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
        throw error;
      }
    },
    async put(key, bytes, mime) {
      await s3.send(new PutObjectCommand({ Bucket: config.bucketName, Key: key, Body: bytes, ContentType: mime }), {
        abortSignal: AbortSignal.timeout(30_000),
      });
    },
    async *list(prefix) {
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({
          Bucket: config.bucketName, Prefix: prefix, ContinuationToken: token,
        }));
        for (const object of page.Contents ?? []) {
          if (!object.Key || !object.LastModified || object.Size === undefined) {
            throw new Error('R2 listing returned incomplete object metadata');
          }
          yield { key: object.Key, lastModified: object.LastModified, size: object.Size };
        }
        if (page.IsTruncated && !page.NextContinuationToken) throw new Error('R2 listing ended without a continuation token');
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: config.bucketName, Key: key }), {
        abortSignal: AbortSignal.timeout(30_000),
      });
    },
  };
  return { db, objects };
}
