"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectTransactionId = detectTransactionId;
const vision = __importStar(require("@google-cloud/vision"));
const jsqr_1 = __importDefault(require("jsqr"));
const pngjs_1 = require("pngjs");
const sharp_1 = __importDefault(require("sharp"));
const transaction_id_1 = require("./transaction-id");
async function detectFromImageQr(buffer) {
    const image = (0, sharp_1.default)(buffer);
    const png = pngjs_1.PNG.sync.read(await image.png().toBuffer());
    const code = (0, jsqr_1.default)(Uint8ClampedArray.from(png.data), png.width, png.height);
    return code?.data;
}
async function detectFromImageText(buffer, apiKey) {
    const client = new vision.ImageAnnotatorClient({ key: apiKey });
    const [result] = await client.annotateImage({
        image: { content: new Uint8Array(buffer) },
        features: [{ type: 'TEXT_DETECTION' }],
    });
    const annotations = result.fullTextAnnotation;
    return (0, transaction_id_1.findTransactionId)(annotations?.text ?? undefined);
}
async function detectTransactionId(buffer, params) {
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
//# sourceMappingURL=detect.js.map