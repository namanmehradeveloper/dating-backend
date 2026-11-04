// Configures the Cloudinary SDK when CLOUDINARY_* env vars are set.
// Uploads go to cloud folders dating-cloud/profile|verification|chat.

import { v2 as cloudinary } from 'cloudinary';
import { env } from './env.js';

let configured = false;

export function isCloudinaryEnabled() {
  return env.cloudinary.enabled;
}

function ensureConfigured() {
  if (!env.cloudinary.enabled) {
    throw new Error('Cloudinary is not configured');
  }
  if (!configured) {
    cloudinary.config({
      cloud_name: env.cloudinary.cloudName,
      api_key: env.cloudinary.apiKey,
      api_secret: env.cloudinary.apiSecret,
      secure: true,
    });
    configured = true;
  }
  return cloudinary;
}

// Uploads a processed image buffer. Returns { publicId, secureUrl, bytes, width, height }.
export function uploadImageBuffer(buffer, { folder, fileName, contentType }) {
  const client = ensureConfigured();
  const publicId = fileName.replace(/\.[^.]+$/, '');

  return new Promise((resolve, reject) => {
    const stream = client.uploader.upload_stream(
      {
        folder: `dating-cloud/${folder}`,
        public_id: publicId,
        resource_type: 'image',
        overwrite: false,
        unique_filename: false,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({
          publicId: result.public_id,
          secureUrl: result.secure_url,
          bytes: result.bytes,
          width: result.width,
          height: result.height,
          contentType: contentType || `image/${result.format}`,
        });
      },
    );
    stream.end(buffer);
  });
}

// Deletes a Cloudinary asset by public_id. Missing assets are ignored.
export async function destroyCloudinaryImage(publicId) {
  if (!publicId || !env.cloudinary.enabled) return;
  const client = ensureConfigured();
  await client.uploader.destroy(publicId, { resource_type: 'image' });
}
