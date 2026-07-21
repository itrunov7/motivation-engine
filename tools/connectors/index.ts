/**
 * tools/connectors/index.ts — connector registry.
 *
 * Every connector registers here under its CLI id; tools/run-connector.ts
 * looks connectors up in this map. Real connectors (openalex, wayback-cdx,
 * …) plug in alongside the dummy as they are built.
 */

import type { Connector } from "./types";
import { dummyConnector } from "./dummy";
import { evidenceConnector } from "./evidence";
import { realizationWaybackConnector } from "./realization-wayback";
import { waybackConnector } from "./wayback";

export const CONNECTORS: Record<string, Connector> = {
  [dummyConnector.id]: dummyConnector,
  [evidenceConnector.id]: evidenceConnector,
  [realizationWaybackConnector.id]: realizationWaybackConnector,
  [waybackConnector.id]: waybackConnector,
};
