import { CopyTrader } from "./copyTrader.js";
import { logger } from "./logger.js";

const trader = new CopyTrader();

trader.start().catch((error) => {
  logger.error({ error }, "Fatal error");
  process.exit(1);
});
