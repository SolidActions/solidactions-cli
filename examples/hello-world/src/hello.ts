import { SolidActions } from "@solidactions/sdk";

async function greet() {
  SolidActions.logger.info("Hello from SolidActions!");
  return { message: "Hello, world!" };
}

async function farewell() {
  SolidActions.logger.info("Goodbye from SolidActions!");
  return { message: "Goodbye!" };
}

async function helloWorkflow() {
  const greeting = await SolidActions.runStep(() => greet());
  const goodbye = await SolidActions.runStep(() => farewell());
  return { greeting, goodbye };
}

export default SolidActions.registerWorkflow(helloWorkflow);
