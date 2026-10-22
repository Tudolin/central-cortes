import { EventEmitter } from "node:events";

/** Barramento interno: toda mudança de job/clip/canal vira um evento SSE para o dashboard. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);
