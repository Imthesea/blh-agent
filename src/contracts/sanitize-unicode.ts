/**
 * 去除未配对的 Unicode 代理项。
 *
 * 未配对的代理项（0xD800-0xDBFF 的高代理项没有跟随 0xDC00-0xDFFF 的低代理项，
 * 或反之）会导致很多 provider 在 JSON 序列化时出错。合法的 emoji 等基本多文种平面
 * 之外的字符使用正确配对的代理项，不受本函数影响。
 *
 * 移植自 pi（MIT License, Copyright (c) 2025 Mario Zechner）。
 *
 * @param text - 待清洗的文本
 * @returns 移除未配对代理项后的文本
 */
export function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}