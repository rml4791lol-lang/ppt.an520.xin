"use client";

// 开关板门控测试包的客户端并入：/api/features 对本用户可见的 gated 包才进选择列表。
// 包数据本身是公开静态资产，可见性由服务端硬门兜底，这里只决定「列不列出来」。
import { useEffect, useState } from "react";
import { GATED_STYLE_PACKS, type StylePack } from "@/data/style-packs";
import { getFeatureFlags } from "@/lib/client/deck-api";

export function useGatedStylePacks(): StylePack[] {
  const [gated, setGated] = useState<StylePack[]>([]);
  useEffect(() => {
    getFeatureFlags()
      .then(({ flags }) => {
        setGated(
          GATED_STYLE_PACKS.filter((pack) => pack.featureFlag && flags[pack.featureFlag] === true),
        );
      })
      .catch(() => {});
  }, []);
  return gated;
}
