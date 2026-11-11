// Run by app.test.ts in a process of its own (the bundle is loaded once per
// process, so a test process that already built it says nothing): how many
// times Bun.build has been called after createWebuiApp, then after prepare.
let builds = 0;
const build = Bun.build;
Bun.build = (...args: Parameters<typeof Bun.build>) => {
  builds += 1;
  return build(...args);
};
const { createWebuiApp } = await import("../src/index.ts");
const app = createWebuiApp();
await Bun.sleep(50);
const afterCreate = builds;
app.prepare();
const afterPrepare = builds;
console.log(JSON.stringify({ afterCreate, afterPrepare }));
process.exit(0);

export {};
