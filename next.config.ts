import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 镜像改成在 GitHub Actions 上构建、云端只 pull（HANDOFF 踩坑 40）之后，
  // 每次部署都要把镜像从网上拉到那台 1 核小机器上，体积直接变成部署耗时。
  // standalone 只产出 server.js + 追踪到的那部分 node_modules，不带 dev 依赖和源码。
  output: "standalone",
  // 文件追踪靠静态分析 import/require，认不出原生模块的 .node 二进制；
  // better-sqlite3 漏了的话容器一起来就 crash，显式带上（官方文档给的就是这个办法）。
  outputFileTracingIncludes: {
    "/*": ["node_modules/better-sqlite3/build/Release/*.node"],
  },
  async headers() {
    return [
      {
        // sw.js 缓存了就更新不了，浏览器必须每次都拿到最新版本才能收到新推送逻辑
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

export default nextConfig;
