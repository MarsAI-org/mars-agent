import { isBunTestRuntime } from "@marsai-org/utils/env";

process.stdout.write(JSON.stringify(isBunTestRuntime()));
