#!/usr/bin/env node
import { main, log } from "./main.js";

main(process.argv.slice(2)).catch((error: unknown) => {
  log.error("致命错误", {}, error);
  process.exitCode = 1;
});
