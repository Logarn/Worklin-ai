import { useEffect } from "react";

import { publicAsset } from "@/utils/public-asset";

const DEFAULT_FAVICON = publicAsset("/favicon-32x32.png");

/**
 * Uses an uploaded assistant identity image as the favicon when present.
 * Character-rendered identities keep the stable Worklin product mark.
 */
export function useDynamicFavicon(
  customImageUrl: string | null,
): void {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;

    link.href = customImageUrl ?? DEFAULT_FAVICON;

    return () => {
      link.href = DEFAULT_FAVICON;
    };
  }, [customImageUrl]);
}
