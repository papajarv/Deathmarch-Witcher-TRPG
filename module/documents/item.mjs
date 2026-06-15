/**
 * WitcherItem — base Item document for the system.
 *
 * Mixin-host pattern. Phase 5 adds consume; Phase 7 will add repair,
 * dismantle, defenseOption mixins as the chrome port lands them.
 */

import { consumeMixin } from "./mixins/consumeMixin.mjs";
import { reloadMixin } from "./mixins/reloadMixin.mjs";

export class WitcherItem extends reloadMixin(consumeMixin(Item)) {
}
