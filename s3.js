import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
    CreateBucketCommand,
    HeadBucketCommand,
} from '@aws-sdk/client-s3';

/**
 * @typedef {Object} S3Config
 * @property {string} endpoint S3-compatible endpoint URL
 * @property {string} bucket Bucket name
 * @property {string} accessKey Access key
 * @property {string} secretKey Secret key
 */

/**
 * @typedef {Object} S3Handle
 * @property {S3Client} client
 * @property {string} bucket
 * @property {(key: string, body: Buffer, contentType?: string) => Promise<void>} put
 * @property {(key: string) => Promise<import('@aws-sdk/client-s3').GetObjectCommandOutput>} get
 * @property {(key: string) => Promise<void>} del
 * @property {(prefix: string) => Promise<string[]>} list
 */

/**
 * Initialize S3 client and ensure bucket exists.
 * @param {S3Config} config
 * @returns {S3Handle}
 */
export async function initS3(config) {
    const client = new S3Client({
        endpoint: config.endpoint,
        region: 'us-east-1',
        credentials: {
            accessKeyId: config.accessKey,
            secretAccessKey: config.secretKey,
        },
        forcePathStyle: true,
    });

    const bucket = config.bucket;

    try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
        try {
            await client.send(new CreateBucketCommand({ Bucket: bucket }));
            console.log(`[sillytavern-vault/s3] Created bucket: ${bucket}`);
        } catch (err) {
            console.error(`[sillytavern-vault/s3] Failed to create bucket: ${err.message}`);
        }
    }

    return {
        client,
        bucket,

        async put(key, body, contentType = 'application/octet-stream') {
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: body,
                ContentType: contentType,
            }));
        },

        async get(key) {
            return client.send(new GetObjectCommand({
                Bucket: bucket,
                Key: key,
            }));
        },

        async del(key) {
            await client.send(new DeleteObjectCommand({
                Bucket: bucket,
                Key: key,
            }));
        },

        async list(prefix) {
            const result = await client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
            }));
            return (result.Contents || []).map(obj => obj.Key);
        },
    };
}
