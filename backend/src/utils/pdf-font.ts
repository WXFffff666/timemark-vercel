import fontkit from '@pdf-lib/fontkit';
import type { PDFDocument, PDFFont } from 'pdf-lib';
import { PDF_FONT_OTF_BASE64 } from '../assets/pdf-font-subset.js';

/**
 * 用药报告 PDF 的内嵌 CJK 字体（checkbox 74）。
 *
 * 为什么把字体以 base64 提交而不是运行时读文件：后端既跑 tsx（开发）/ vitest，
 * 又被 esbuild 打成单文件 `api/handler.cjs` 部署到 Vercel 函数——磁盘路径在三种
 * 环境里都不成立，而纯 TS 常量在三处行为完全一致。
 *
 * 字体为 Noto Sans SC Regular 的子集（SIL OFL 1.1，见 assets/LICENSE-NotoSansSC.txt），
 * 由 `scripts/build-pdf-font-subset.mjs` 生成；字节只解码一次并缓存。
 */
let cachedBytes: Uint8Array | null = null;

/** 子集字体字节（进程内解码一次并复用）。 */
export function reportPdfFontBytes(): Uint8Array {
  if (cachedBytes === null) {
    cachedBytes = Buffer.from(PDF_FONT_OTF_BASE64, 'base64');
  }
  return cachedBytes;
}

/** 注册 fontkit 并内嵌报告字体（subset：PDF 只带实际用到的字形）。 */
export async function embedReportFont(doc: PDFDocument): Promise<PDFFont> {
  doc.registerFontkit(fontkit);
  return doc.embedFont(reportPdfFontBytes(), { subset: true });
}
