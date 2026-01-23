import * as vision from '@google-cloud/vision';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { findTransactionId } from './transaction-id';

async function detectFromImageQr(buffer: Buffer) {
  const image = sharp(buffer);
  const png = PNG.sync.read(await image.png().toBuffer());
  const code = jsQR(Uint8ClampedArray.from(png.data), png.width, png.height);
  return code?.data;
}

async function detectFromImageText(buffer: Buffer, apiKey: string) {
  const client = new vision.ImageAnnotatorClient({ key: apiKey });

  const [result] = await client.annotateImage({
    image: { content: new Uint8Array(buffer) },
    features: [{ type: 'TEXT_DETECTION' }],
  });

  const annotations = result.fullTextAnnotation;
  return findTransactionId(annotations?.text ?? undefined);
}

export async function detectTransactionId(
  buffer: Buffer,
  params: { googleVisionAPIKey?: string }
): Promise<DetectTransactionIdResult | null> {
  const start = Date.now();
  const fromQr = await detectFromImageQr(buffer);
  if (fromQr)
    return {
      value: fromQr,
      detectedFrom: 'QR_CODE',
      timeTaken: Date.now() - start,
    };

  if (params.googleVisionAPIKey) {
    const fromText = await detectFromImageText(buffer, params.googleVisionAPIKey);
    if (fromText)
      return {
        value: fromText,
        detectedFrom: 'TEXT_RECOGNITION',
        timeTaken: Date.now() - start,
      };
  }

  return null;
}

export type DetectTransactionIdResult = {
  value: string;
  detectedFrom: 'QR_CODE' | 'TEXT_RECOGNITION';
  timeTaken: number;
};
