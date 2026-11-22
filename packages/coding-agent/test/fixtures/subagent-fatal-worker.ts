// Dies like a CLI-hosted worker whose entry failed to load: through `fatal()`, before the ready report.
import { fatal } from "@marsai-org/utils/postmortem";

void fatal(new Error("Cannot find module './gone'"));
