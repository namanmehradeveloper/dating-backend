// Generates small real images in memory for upload tests.

import sharp from 'sharp';

// Builds a 64x48 solid-colour image in the given format. `exif` adds camera metadata to test stripping.
export async function makeImage(format = 'jpeg', { exif } = {}) {
  let image = sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 40, b: 90 } } });
  if (exif) image = image.withExif(exif);
  return image.toFormat(format).toBuffer();
}
