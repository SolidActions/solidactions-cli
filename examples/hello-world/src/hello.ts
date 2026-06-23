import { SolidActions, defineWorkflow } from "@solidactions/sdk";

async function greet(): Promise<{ message: string }> {
  SolidActions.logger.info("Hello from SolidActions!");
  return { message: "Hello, world!" };
}

async function farewell(): Promise<{ message: string }> {
  SolidActions.logger.info("Goodbye from SolidActions!");
  return { message: "Goodbye!" };
}

export default defineWorkflow({
  name: "hello",
  async run(ctx) {
    const greeting = await SolidActions.runStep(() => greet(), { name: "greet" });
    const goodbye = await SolidActions.runStep(() => farewell(), { name: "farewell" });
    return { greeting, goodbye };
  },
});
