import { useEffect, useRef, useState } from 'react';

/**
 * 「這個元素進到畫面了嗎」——決定 Facebook 嵌入框什麼時候載入。
 *
 * - 進過畫面就維持 `true`（sticky）：嵌入框不會因為捲上捲下反覆拆掉重載。
 * - `IntersectionObserver` 不存在的環境（server render、很舊的瀏覽器）一律回 `false`：
 *   呼叫端要保持「沒偵測到就不載入」的保守行為，不要退化成一次載入全部。
 * - `rootMargin` 預設 200px：元素還差 200px 進畫面就先載，捲到時通常已經好了。
 */
export function useInView<T extends Element>(rootMargin = '200px') {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);

  return { ref, inView };
}
