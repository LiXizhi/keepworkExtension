// Product builds replace this module with immutable metadata for that bundle.
// Direct source execution has no build date unless one is explicitly supplied.
export const runtimeBuildInfo: { version?: string; commit?: string; builtAt?: string } = {
    version: process.env.KEEPWORK_MCP_BUILD_VERSION,
    commit: process.env.KEEPWORK_MCP_BUILD_COMMIT,
    builtAt: process.env.KEEPWORK_MCP_BUILD_DATE,
};
