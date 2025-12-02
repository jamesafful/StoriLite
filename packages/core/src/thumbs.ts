import sharp from 'sharp';

export async function makeThumb(input: Buffer): Promise<Buffer> {
  return sharp(input).resize({ width: 512, withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
}
