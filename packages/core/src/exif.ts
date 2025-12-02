import * as exifr from 'exifr';

export async function extractExif(buf: Buffer): Promise<{
  createdTs?: number;
  lat?: number;
  lon?: number;
  place?: string;
}> {
  try {
    const data: any = await exifr.parse(buf, { tiff: true, ifd0: true, xmp: true, exif: true, gps: true });
    const created = data?.DateTimeOriginal || data?.CreateDate || data?.ModifyDate;
    const ts = created ? new Date(created).getTime() : undefined;
    const lat = data?.latitude;
    const lon = data?.longitude;
    return { createdTs: ts, lat, lon, place: undefined };
  } catch {
    return {};
  }
}
