#!/usr/bin/env node
import { messageOf } from "./errors";
import { main } from "./server";

if (import.meta.main) {
  main().catch((error) => {
    console.error(`ERROR: ${messageOf(error)}`);
    process.exit(1);
  });
}
