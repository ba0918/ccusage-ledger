#!/usr/bin/env bun
import { main } from "./server";

if (import.meta.main) {
  void main();
}
