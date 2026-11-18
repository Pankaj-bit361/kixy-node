// The job kinds this server runs. A video renderer would be one more entry here.
import type { Db } from "./db/pool.js";
import type { JobHandler } from "./jobs.js";
import { clipperHandler } from "./pipelines/clipper.js";
import { coloringHandler } from "./pipelines/coloring.js";
import { imagesHandler } from "./pipelines/images.js";
import type { Services } from "./pipelines/services.js";
import { storyboardHandler } from "./pipelines/storyboard.js";

export function jobHandlers(db: Db, services: Services): Record<string, JobHandler> {
  return {
    clip: clipperHandler(db, services),
    storyboard: storyboardHandler(services),
    images: imagesHandler(services),
    coloring: coloringHandler(services),
  };
}
