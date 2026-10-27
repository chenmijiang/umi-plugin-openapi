export async function getSchema(schemaPath: string, authorization?: string): Promise<unknown> {
  if (schemaPath.startsWith("http")) {
    try {
      // 使用 Node 原生 fetch，保留 TLS 证书校验；内部 CA 通过启动进程前设置
      // NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem 加入信任，运行中设置不生效。
      const json = await fetch(schemaPath, {
        headers: authorization ? { authorization } : {},
      }).then((rest) => rest.json());
      return json;
    } catch (error) {
      console.log("fetch openapi error:", error);
    }
    return null;
  }
  // Node caches modules by resolved filename, which may differ for symlinked paths.
  const resolvedPath = require.resolve(schemaPath);
  delete require.cache[resolvedPath];
  const schema = require(resolvedPath);
  return schema;
}
