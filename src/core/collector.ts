import type { OutputChunk } from './contract';

export interface OutputCollector {
  emit(chunk: Omit<OutputChunk, 'seq'>): void;
  snapshot(): OutputChunk[];
  overflow(): boolean;
  bytes(): number;
}

const encoder = new TextEncoder();

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/** 按 Unicode 码点截断，避免把中文或 emoji 切出半个 surrogate。 */
function truncateByBytes(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s;
  const cps = Array.from(s);
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (byteLength(cps.slice(0, mid).join('')) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return cps.slice(0, lo).join('');
}

/**
 * 统一输出收集：字节口径计数（不是字符数），超限后停止接收并留下可观察的 info 条目。
 * 判据押「能读回字节」，不押「没抛错」。
 */
export function createCollector(limitBytes: number): OutputCollector {
  const chunks: OutputChunk[] = [];
  let total = 0;
  let overflowed = false;

  return {
    emit(chunk) {
      if (overflowed) return;
      const remaining = limitBytes - total;
      if (remaining <= 0) {
        overflowed = true;
        return;
      }
      const raw = chunk.text;
      const size = byteLength(raw);
      const text = size > remaining ? truncateByBytes(raw, remaining) : raw;
      const seq = chunks.length;
      chunks.push({ stream: chunk.stream, text, seq });
      total += byteLength(text);
      if (size > remaining) overflowed = true;
    },
    snapshot() {
      if (!overflowed) return [...chunks];
      return [
        ...chunks,
        {
          stream: 'info' as const,
          text: `[输出已截断：超过 ${limitBytes} 字节，后续输出丢弃]`,
          seq: chunks.length,
        },
      ];
    },
    overflow() {
      return overflowed;
    },
    bytes() {
      return total;
    },
  };
}
