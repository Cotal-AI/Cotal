import { createMDX } from 'fumadocs-mdx/next';
export default createMDX()({ output: 'export', agentRules: false, trailingSlash: true, images: { unoptimized: true } });
