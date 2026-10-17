import { Router, json } from 'express';
import { registerAdminRoutes } from './admin.js';
import { registerLibraryRoutes } from './library.js';
import { registerRequestRoutes } from './requests.js';
import { registerSessionRoutes } from './session.js';

export { listenerRemoteIpGuard, listenerRemoteListenerKey, recordRefusal } from './shared.js';

// Each area registers its own routes; the paths do not overlap, so their order does not matter.
export const listenerRemoteRoutes: Router = Router();
export const listenerRemoteAdminRoutes: Router = Router();

listenerRemoteRoutes.use(json({ limit: '4kb' }));
registerSessionRoutes(listenerRemoteRoutes);
registerLibraryRoutes(listenerRemoteRoutes);
registerRequestRoutes(listenerRemoteRoutes);

registerAdminRoutes(listenerRemoteAdminRoutes);
