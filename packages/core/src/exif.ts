import * as exifr from 'exifr';

export async function extractExif(buf: Buffer): Promise<{
  createdTs?: number;
  lat?: number;
  lon?: number;
  place?: string;
}> {
  try {
    // Looser call avoids option type mismatch across exifr versions
    const data: any = await (exifr as any).parse(buf);
    const created: any = data?.DateTimeOriginal || data?.CreateDate || data?.ModifyDate;
    const ts = created ? new Date(created).getTime() : undefined;
    const lat = data?.latitude;
    const lon = data?.longitude;
    return { createdTs: ts, lat, lon, place: undefined };
  } catch {
    return {};
  }
}
