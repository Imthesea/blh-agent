/** 读取环境变量：存在且非空才返回值，否则返回 undefined（空串视为未设置）。 */
export function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : undefined;
}
